import fitz  # PyMuPDF
import pytesseract
from PIL import Image
import os
import uuid
import datetime
import hashlib
import json
import time
import random
import sys
import io
import requests
import shutil
import re
import base64
import ctypes
import unicodedata
from db_manager import add_document, get_document_by_sha256

# Force UTF-8 for Windows output
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer, encoding="utf-8", line_buffering=True
    )
    sys.stderr = io.TextIOWrapper(
        sys.stderr.buffer, encoding="utf-8", line_buffering=True
    )


def report_status(msg, progress=None, doc_id=None, **kwargs):
    """Prints a JSON status message for the Electron frontend."""
    status = {"type": "status", "msg": msg, "progress": progress}
    if doc_id:
        status["doc_id"] = doc_id
    if "extra" in kwargs:
        status.update(kwargs["extra"])
    print(json.dumps(status, ensure_ascii=False), flush=True)


# Configure tesseract path - Support for portable bundling
def get_tesseract_path():
    # 1. Check for bundled tesseract in project root (Development or Specific Deployment)
    local_bin = os.path.join(os.getcwd(), "bin", "tesseract", "tesseract.exe")
    if os.path.exists(local_bin):
        return local_bin

    # 2. Check for tesseract relative to executable (Packaged Production)
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        prod_bin = os.path.join(exe_dir, "..", "bin", "tesseract", "tesseract.exe")
        if os.path.exists(prod_bin):
            return prod_bin

    # 3. Fallback to standard installation path
    return r"C:\Program Files\Tesseract-OCR\tesseract.exe"


pytesseract.pytesseract.tesseract_cmd = get_tesseract_path()


def hide_file(path):
    """Sets the hidden attribute on a file (Windows only)."""
    if sys.platform == "win32":
        try:
            # 0x02 is the attribute for HIDDEN
            ctypes.windll.kernel32.SetFileAttributesW(path, 0x02)
        except Exception as e:
            print(f"Error hiding file {path}: {e}", flush=True)


def get_file_hash(file_path):
    hash_sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_sha256.update(chunk)
    return hash_sha256.hexdigest()


def extract_text_from_pdf(file_path):
    text = ""
    report_status("status_extracting", 20)
    try:
        doc = fitz.open(file_path)
        for page in doc:
            text += page.get_text()
        doc.close()
    except Exception as e:
        print(f"Error extracting text with PyMuPDF: {e}", flush=True)

    # If text is too short, try OCR
    if len(text.strip()) < 50:
        report_status("status_ocr", 50)
        try:
            doc = fitz.open(file_path)
            for i in range(min(len(doc), 5)):  # OCR first 5 pages max for speed
                page = doc.load_page(i)
                pix = page.get_pixmap()
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                text += pytesseract.image_to_string(img, lang="ara+eng")
            doc.close()
        except Exception as e:
            print(f"OCR Error: {e}", flush=True)

    return text


def extract_text_from_image(file_path):
    report_status("status_ocr", 40)
    try:
        img = Image.open(file_path)
        text = pytesseract.image_to_string(img, lang="ara+eng")
        return text
    except Exception as e:
        print(f"Image OCR Error: {e}", flush=True)
        return ""


def get_file_base64(file_path):
    """Encodes a file to base64 for AI multimodal input."""
    try:
        with open(file_path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
    except Exception as e:
        print(f"Error encoding file for AI: {e}", flush=True)
        return None


def real_ai_analyze(text, filename, file_path=None):
    """Call OpenRouter API to analyze the document content using Multimodal Vision."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    ai_model = os.environ.get("AI_MODEL", "google/gemini-2.0-flash-001")

    if not api_key:
        print("Error: OPENROUTER_API_KEY is missing in background process.", flush=True)
        return None

    # Limit text to 6000 chars for speed and context window safety in background
    truncated_text = text[:6000] if text else "No text extracted (Image/Scan)"

    # -------------------------------------------------------
    # البرومبت: يستخرج البيانات بأسلوب few-shot واضح
    # -------------------------------------------------------
    prompt = f"""أنت مُحلل وثائق إداري خبير. مهمتك هي استخراج البيانات الوصفية (Metadata) بدقة عالية من الوثيقة المرفقة.
    
    اسم الملف الأصلي: {filename}

    سياق الوثيقة:
    - قد تحتوي الصفحة على ترويسة (Header) بها شعارات وتواريخ وأرقام "ثابتة" للمنظمة.
    - ابحث عن "الموضوع" (Subject) الفعلي داخل نص الوثيقة وليس مجرد أول سطر.
    - ابحث عن "تاريخ الوثيقة" (Document Date) وهو تاريخ صدور الخطاب وليس تاريخ اليوم أو تواريخ عشوائية في الشعارات.
    - استخرج "المشروع" (Project) الذي تتعلق به الوثيقة إذا ذكر.
    - استخرج "رقم الصادر/الوارد" كـ version_no.

    محتوى النص المستخرج (للمساعدة):
    {truncated_text}

    المطلوب إرجاع JSON بالصيغة التالية فقط:
    {{
      "subject": "موضوع الوثيقة بدقة",
      "project": "اسم المشروع (أو 'عام')",
      "doc_date": "YYYY-MM-DD",
      "version_no": "رقم الخطاب الأصلي",
      "title": "عنوان قصير مناسب للملف",
      "class": "نوع الوثيقة من القائمة التالية فقط: خطاب | تقرير | لوحة هندسية | محضر اجتماع | عقد | فاتورة | مواصفة فنية | مذكرة داخلية | موافقة | أخرى",
      "summary": "ملخص من سطر واحد",
      "intel_card": "موجز معلوماتي شامل (الموضوع، الجهة، التاريخ، الرقم)"
    }}

    قواعد هامة:
    1. لا تكرر اسم الحقل داخل القيمة.
    2. التاريخ: حوله لـ YYYY-MM-DD. إذا كان هجرياً حوله لميلادي تقريبي أو اتركه كما هو بصيغة نصية إذا تعذر التحويل.
    3. إذا لم تجد معلومة، اترك القيمة فارغة "" ولا تخمن.
    4. ركز على "جوهر" الوثيقة وليس الهوامش.
    5. لحقل "class": اختر من القائمة فقط — لو الوثيقة ورقة مراسلة بين جهتين فهي "خطاب"، لو وثيقة فنية هندسية فهي "لوحة هندسية".
    """

    try:
        response = requests.post(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            data=json.dumps(
                {
                    "model": ai_model,
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": prompt}]}
                    ],
                    "response_format": {"type": "json_object"},
                }
            ),
            timeout=45,  # Increased timeout for larger image/pdf payloads
        )

        # Add visual context if file_path is provided (Multimodal upgrade)
        if file_path and os.path.exists(file_path):
            base64_data = get_file_base64(file_path)
            if base64_data:
                ext = os.path.splitext(file_path)[1].lower()
                mime_type = "application/pdf" if ext == ".pdf" else "image/jpeg"
                if ext == ".png":
                    mime_type = "image/png"
                elif ext == ".webp":
                    mime_type = "image/webp"

                # Update payload with the actual file content (Vision/PDF ingestion)
                # Note: We rebuild the payload here to include the file
                payload = {
                    "model": ai_model,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {
                                    "type": "image_url" if ext != ".pdf" else "file",
                                    "image_url": {
                                        "url": f"data:{mime_type};base64,{base64_data}"
                                    }
                                    if ext != ".pdf"
                                    else None,
                                },
                            ],
                        }
                    ],
                    "response_format": {"type": "json_object"},
                }

                # Special handling for PDF/File types in OpenRouter if needed
                if ext == ".pdf":
                    # OpenRouter usually takes PDFs in a similar way or as a specific 'file' type depending on provider
                    # But for Gemini, image_url works for images, and some providers support application/pdf in image_url or a 'document' type
                    # Let's match the working Chat logic in main.js precisely:
                    # contentArray.push({ type: 'image_url', image_url: { url: dataUrl } }); (even for PDF in main.js?)
                    # Wait, looking at main.js line 443: contentArray.push({ type: 'image_url', image_url: { url: dataUrl } });
                    # Yes, main.js uses 'image_url' even for PDF data URLs when sending to OpenRouter.
                    payload["messages"][0]["content"][1] = {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{base64_data}"},
                    }

                response = requests.post(
                    url="https://openrouter.ai/api/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    data=json.dumps(payload),
                    timeout=45,
                )

        if response.status_code == 200:
            result = response.json()
            if "choices" not in result:
                print(f"API Warning: No choices in response: {result}", flush=True)
                return None

            raw_content = result["choices"][0]["message"]["content"]

            # --- Robust Extraction Logic ---
            def extract_json_data(text):
                # 1. Try direct JSON parsing
                try:
                    # Find potential JSON block using regex if wrapped in markdown
                    json_match = re.search(r"\{.*\}", text, re.DOTALL)
                    if json_match:
                        return json.loads(json_match.group(0))
                except:
                    pass

                # 2. Case: AI included multiple JSON blocks or garbage text
                try:
                    # Clean markdown code blocks
                    content_clean = re.sub(r"```json\s*|\s*```", "", text)
                    return json.loads(content_clean.strip())
                except:
                    pass

                # 3. Last Resort: Regex-based field extraction (The Fail-Safe)
                print(
                    f"DEBUG: JSON parsing failed, using Fail-Safe field extraction.",
                    flush=True,
                )
                recovered_data = {}
                patterns = {
                    "subject": r'"subject"\s*:\s*"([^"]*)"',
                    "project": r'"project"\s*:\s*"([^"]*)"',
                    "doc_date": r'"doc_date"\s*:\s*"([^"]*)"',
                    "version_no": r'"version_no"\s*:\s*"([^"]*)"',
                    "title": r'"title"\s*:\s*"([^"]*)"',
                    "class": r'"class"\s*:\s*"([^"]*)"',
                    "summary": r'"summary"\s*:\s*"([^"]*)"',
                    "intel_card": r'"intel_card"\s*:\s*"([^"]*)"',
                }
                for key, pattern in patterns.items():
                    match = re.search(pattern, text)
                    if match:
                        recovered_data[key] = match.group(1)

                return recovered_data if recovered_data else None

            ai_data = extract_json_data(raw_content)

            if not ai_data:
                print(
                    f"CRITICAL: Failed to extract any data from AI response.",
                    flush=True,
                )
                print(f"RAW AI RESPONSE START: {raw_content[:500]}", flush=True)
                return None

            ai_data["type"] = "PDF" if filename.lower().endswith(".pdf") else "IMAGE"
            # Use the AI-extracted class; fall back to 'أخرى' if not provided
            ai_data.setdefault("class", "أخرى")
            ai_data.setdefault("area", "غير محدد")
            ai_data.setdefault("tags", [])

            # --- Post-processing: Strip field labels if AI included them in values ---
            def strip_field_label(value, labels):
                """Removes common field label prefixes that the AI may accidentally include."""
                if not isinstance(value, str):
                    return value
                for label in labels:
                    if value.strip().startswith(label):
                        return value.strip()[len(label) :].strip().lstrip(":").strip()
                return value.strip()

            ai_data["subject"] = strip_field_label(
                ai_data.get("subject", ""), ["الموضوع", "بشأن", "subject", "Subject"]
            )
            ai_data["project"] = strip_field_label(
                ai_data.get("project", ""), ["المشروع", "الجهة", "project", "Project"]
            )
            # For date: only strip if has explicit label prefix, don't strip valid dates
            raw_date = ai_data.get("doc_date", "") or ""
            if raw_date in ("غير محدد", "غير_محدد", "N/A", "unknown", "null", "None"):
                ai_data["doc_date"] = ""
            else:
                ai_data["doc_date"] = strip_field_label(
                    raw_date, ["التاريخ:", "date:", "Date:"]
                )
            # For version_no: strip label prefixes
            ai_data["version_no"] = strip_field_label(
                ai_data.get("version_no", ""),
                [
                    "الرقم",
                    "رقم الصادر",
                    "رقم الوارد",
                    "رقم المرجع",
                    "رقم:",
                    "version",
                    "Version",
                ],
            )

            return ai_data
        else:
            print(
                f"AI API Failed with status {response.status_code}: {response.text}",
                flush=True,
            )
            sys.stderr.write(
                f"API Error {response.status_code}: {response.text[:100]}\n"
            )

    except Exception as e:
        print(f"AI Analysis Request Failed: {e}", flush=True)
        sys.stderr.write(f"OPENROUTER API ERROR: {str(e)}\n")

    return None


def mock_ai_analyze(text, filename):
    """Fallback logic if real AI fails, or if Auto-Analysis is disabled."""
    ext = os.path.splitext(filename)[1].lower()
    file_format = "PDF" if ext == ".pdf" else "IMAGE"

    # Format filename into a readable title
    raw_name = os.path.splitext(filename)[0]
    readable_title = raw_name.replace("_", " ").replace("-", " ").title()

    return {
        "title": readable_title,
        "subject": "",
        "project": "",
        "doc_date": "",
        "version_no": "",
        "type": file_format,
        "class": "أخرى",
        "area": "",
        "tags": [],
        "summary": f"تمت الإضافة بدون تحليل (الذكاء الاصطناعي مغلق). يرجى التعديل يدوياً.",
    }


def sanitize_folder_name(name):
    """Removes invalid characters and normalizes Arabic text to NFC."""
    if not name:
        return "غير_محدد"
    # Normalize to NFC to prevent duplicate folders with different encoding
    name = unicodedata.normalize("NFC", str(name))
    cleaned = re.sub(r'[<>:"/\\|?*]', "", name).strip()
    return cleaned or "غير_محدد"


def organize_file_copy(doc_data, base_archive_path):
    """
    Creates a hierarchical copy of the file: Year / Project / File
    هيكل المجلدات: السنة / المشروع / الملف  (بدون مجلد الموضوع)
    وينشئ ملف JSON بالبيانات الأربعة بجانب الملف المنظّم.
    """
    try:
        # استخراج السنة من تاريخ الوثيقة (safe handling for None)
        doc_date = doc_data.get("doc_date") or ""
        year = (
            doc_date.split("-")[0]
            if doc_date and "-" in doc_date and len(doc_date) >= 4
            else datetime.datetime.now().strftime("%Y")
        )

        # اسم المشروع فقط — بدون مجلد الموضوع (safe handling for None)
        project_raw = doc_data.get("project") or "غير_محدد"
        project = sanitize_folder_name(project_raw)

        # بناء المسار: السنة / المشروع
        target_dir = os.path.join(base_archive_path, year, project)
        os.makedirs(target_dir, exist_ok=True)

        # استخراج اسم الملف الجديد من "الموضوع"
        subject_raw = doc_data.get("subject") or "وثيقة_غير_معروفة"
        # تنظيف الموضوع ليكون صالحاً كاسم ملف
        clean_subject = sanitize_folder_name(subject_raw)

        # الاحتفاظ بالامتد�ير_محدد"
        project = sanitize_folder_name(project_raw)

        # بناء المسار: السنة / المشروع
        target_dir = os.path.join(base_archive_path, year, project)
        os.makedirs(target_dir, exist_ok=True)

        # استخراج اسم الملف الجديد من "الموضوع"
        subject_raw = doc_data.get("subject") or "وثيقة_غير_معروفة"
        # تنظيف الموضوع ليكون صالحاً كاسم ملف
        clean_subject = sanitize_folder_name(subject_raw)

        # الاحتفاظ بالامتداد الأصلي
        ext = os.path.splitext(doc_data.get("file", ".pdf"))[1]
        if not ext:
            ext = ".pdf"

        # بناء اسم الملف الجديد
        new_filename = f"{clean_subject}{ext}"
        target_file_path = os.path.join(target_dir, new_filename)
        # اسم ملف الـ JSON المرافق
        json_filename = f"{clean_subject}.json"

        # معالجة تعارض الأسماء (إذا وجد ملف بنفس الموضوع)
        if os.path.exists(target_file_path):
            unique_suffix = int(time.time()) % 10000
            new_filename = f"{clean_subject}_{unique_suffix}{ext}"
            target_file_path = os.path.join(target_dir, new_filename)
            json_filename = f"{clean_subject}_{unique_suffix}.json"

        # نقل الملف الأصلي بدلاً من نسخه (لعدم تكرار الملفات)
        source_path = doc_data.get("file_path")
        if source_path and os.path.exists(source_path):
            if source_path != target_file_path:
                shutil.move(source_path, target_file_path)
                print(f"File moved to: {target_file_path}", flush=True)
            else:
                print(f"File already at target: {target_file_path}", flush=True)

        return target_file_path

    except Exception as e:
        print(f"Error organizing file copy: {e}", flush=True)

    return None


def process_file(file_path, output_folder, skip_ai=False, force_reprocess=False):
    """
    1. Extracts text via OCR or basic text extraction
    2. Sends to AI for metadata extraction (or mocks it if skip_ai=True)
    """
    file_path = os.path.abspath(file_path)
    output_folder = os.path.abspath(output_folder)

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in [".pdf", ".jpg", ".jpeg", ".png", ".webp"]:
        return None

    file_name = os.path.basename(file_path)

    # 1. Check for local hidden sidecar JSON first (Fast Skip)
    sidecar_path = os.path.splitext(file_path)[0] + ".json"
    if not force_reprocess and os.path.exists(sidecar_path):
        print(
            f"Smart Skip: Sidecar already exists next to file: {file_name}", flush=True
        )
        return None

    # 2. Check content fingerprint (SHA256) in Database (Deeper Skip)
    file_hash = get_file_hash(file_path)
    existing_doc = get_document_by_sha256(file_hash)
    if not force_reprocess and existing_doc:
        # If it exists in DB but not as a sidecar here, it might have been moved
        # We skip to avoid re-analysis, but could update path if needed
        print(
            f"Smart Skip: Document already archived with hash {file_hash[:8]}",
            flush=True,
        )
        return None

    print(f"Processing: {file_path}", flush=True)

    # Unified ID generation using NFC normalization to match Electron
    normalized_name = unicodedata.normalize("NFC", file_name)
    file_id = hashlib.sha256(normalized_name.encode("utf-8")).hexdigest()[:24]

    report_status("status_processing", 10, doc_id=file_id, extra={"file": file_name})

    try:
        if ext == ".pdf":
            content = extract_text_from_pdf(file_path)
        else:
            content = extract_text_from_image(file_path)

        content = content or ""  # Ensure it's not None

        if skip_ai:
            print(f"Auto-Analysis is OFF. Ingesting {file_name} instantly without AI.", flush=True)
            ai_data = mock_ai_analyze(content, file_name)
        else:
            report_status("status_ai", 80, doc_id=file_id)
            ai_data = real_ai_analyze(content, file_name, file_path)

            # Fallback if AI fails
            if not ai_data:
                report_status(
                    "status_error",
                    85,
                    doc_id=file_id,
                    extra={"error": "AI analysis failed to extract JSON data."},
                )
                print(
                    f"AI ERROR: Failed to extract data for {file_name}. Falling back to mock.",
                    flush=True,
                )
                ai_data = mock_ai_analyze(content, file_name)

        date_str = datetime.datetime.now().strftime("%Y-%m-%d")

        doc_data = {
            "id": file_id,
            "file": file_name,
            "file_path": file_path,
            "date_added": date_str,
            "title": ai_data.get("title", file_name),
            "subject": ai_data.get("subject", "غير محدد"),
            "project": ai_data.get("project", "غير محدد"),
            "doc_date": ai_data.get("doc_date", date_str),
            "version_no": ai_data.get("version_no", "غير محدد"),
            "type": ai_data.get("type", "document"),
            "class": ai_data.get("class", "وثيقة"),
            "area": ai_data.get("area", "غير محدد"),
            "tags": ai_data.get("tags", []),
            "summary": ai_data.get("summary", ""),
            "intel_card": ai_data.get("intel_card", ""),
            "content": content,
            "sha256": file_hash,
            "processed_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "status": "ready",
        }

        # Perform Hierarchical Organization: Year / Project / File
        report_status("status_organizing", 90, doc_id=file_id)
        organized_path = organize_file_copy(doc_data, output_folder)
        if organized_path:
            doc_data["file_path"] = organized_path

        # Determine final sidecar path (alongside the file, wherever it is)
        current_file_path = doc_data["file_path"]
        sidecar_path = os.path.splitext(current_file_path)[0] + ".json"

        # Save Consolidated JSON Sidecar
        sidecar_data = {k: v for k, v in doc_data.items() if k != "content"}
        sidecar_data["content_preview"] = content[:500] if content else ""

        with open(sidecar_path, "w", encoding="utf-8") as f:
            json.dump(sidecar_data, f, ensure_ascii=False, indent=2)
        hide_file(sidecar_path)

        # Add to DB
        report_status("status_saving", 95, doc_id=file_id)
        add_document(doc_data)

        print(f"Archived successfully: {file_name}", flush=True)

    except Exception as e:
        print(f"Error in process_file: {e}", flush=True)
        sys.stderr.write(f"PROCESS_FILE ERROR: {str(e)}\n")
    finally:
        if "file_id" in locals():
            print(
                json.dumps(
                    {"type": "sync_complete", "doc_id": file_id}, ensure_ascii=False
                ),
                flush=True,
            )
            report_status("status_idle", 0)

    return doc_data


if __name__ == "__main__":
    if len(sys.argv) > 2:
        file_path_arg = sys.argv[1]
        output_folder_arg = sys.argv[2]
        from db_manager import set_db_path
        set_db_path(output_folder_arg)
        try:
            # Force AI explicitly since this is a manual CLI invocation (like Re-analyze)
            process_file(file_path_arg, output_folder_arg, skip_ai=False, force_reprocess=True)
        except Exception as e:
            print(f"CLI Processing error: {e}", flush=True)
