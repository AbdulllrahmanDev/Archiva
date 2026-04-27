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
import difflib
from db_manager import add_document, get_document_by_sha256, delete_document

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


def cleanup_empty_dirs(start_dir, stop_dir):
    """Recursively deletes empty directories from start_dir up to (but not including) stop_dir."""
    try:
        curr_dir = os.path.abspath(start_dir)
        base_dir = os.path.abspath(stop_dir)
        
        while curr_dir and len(curr_dir) > 3:
            if curr_dir == base_dir:
                break
                
            if os.path.exists(curr_dir) and os.path.isdir(curr_dir) and not os.listdir(curr_dir):
                os.rmdir(curr_dir)
                print(f"Deleted empty directory: {curr_dir}", flush=True)
                curr_dir = os.path.dirname(curr_dir)
            else:
                break
    except Exception as e:
        print(f"Error cleaning up empty directory: {e}", flush=True)


def get_file_hash(file_path):
    hash_sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_sha256.update(chunk)
    return hash_sha256.hexdigest()


def extract_text_from_pdf(file_path, doc_id=None):
    text = ""
    report_status("status_extracting", 20, doc_id=doc_id)
    try:
        doc = fitz.open(file_path)
        for page in doc:
            text += page.get_text()
        doc.close()
    except Exception as e:
        print(f"Error extracting text with PyMuPDF: {e}", flush=True)

    # If text is too short, try OCR
    if len(text.strip()) < 50:
        report_status("status_ocr", 50, doc_id=doc_id)
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


def extract_text_from_image(file_path, doc_id=None):
    report_status("status_ocr", 40, doc_id=doc_id)
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
    api_key_raw = os.environ.get("OPENROUTER_API_KEY")
    ai_model = os.environ.get("AI_MODEL", "google/gemini-2.5-flash-lite")

    if not api_key_raw:
        print("Error: OPENROUTER_API_KEY is missing in background process.", flush=True)
        return None

    # Load Balancing: Pick a random API key if multiple are provided
    api_keys = [k.strip() for k in api_key_raw.split(',') if k.strip()]
    api_key = random.choice(api_keys) if api_keys else None
    
    if not api_key:
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
    - استخرج "المشروع" (Project) الذي تتعلق به الوثيقة. 
    - قاعدة ذهبية: إذا لم يذكر المشروع صراحة، "يجب" استنتاجه بذكاء شديد من الموضوع. 
      مثال: إذا كان الموضوع "شبكة مياه المدينة العمالية"، فإن المشروع هو "المدينة العمالية". 
      مثال: إذا كان الخطاب مرسل بخصوص "مبنى إدارة المرور"، فإن المشروع هو "مبنى إدارة المرور".
    - ابحث عن أسماء (مدن، أحياء، كباري، مستشفيات، جهات، أو أي كيان مادي) واعتبره هو المشروع. 
    - استخرج "المحافظة" (Governorate) التي يقع فيها المشروع أو التي تتبعها الجهة (مثلاً: القاهرة، الإسكندرية، الجيزة، الخ).
    - إذا لم تذكر المحافظة صراحة، حاول استنتاجها من اسم المشروع أو الجهة (مثلاً: "حي المعادي" يتبع محافظة "القاهرة").
    - إذا فشلت تماماً في إيجاد أي إشارة لكيان أو مكان للمشروع، حينها فقط اكتب 'عام' للمشروع و 'غير محددة' للمحافظة.
    - استخرج "رقم الصادر/الوارد" كـ version_no.

    محتوى النص المستخرج (للمساعدة):
    {truncated_text}

    المطلوب إرجاع JSON بالصيغة التالية فقط:
    {{
      "subject": "موضوع الوثيقة بدقة",
      "project": "اسم المشروع (أو 'عام')",
      "governorate": "اسم المحافظة (أو 'غير محددة')",
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
        # -------------------------------------------------------
        # بناء الـ payload الصحيح مرة واحدة فقط (FIX: كان يرسل طلبين)
        # -------------------------------------------------------

        # الـ content الافتراضي: نص فقط
        content_parts = [{"type": "text", "text": prompt}]

        # إضافة الملف (Multimodal) إذا كان متاحاً
        if file_path and os.path.exists(file_path):
            base64_data = get_file_base64(file_path)
            if base64_data:
                ext = os.path.splitext(file_path)[1].lower()
                if ext == ".png":
                    mime_type = "image/png"
                elif ext == ".webp":
                    mime_type = "image/webp"
                elif ext == ".pdf":
                    mime_type = "application/pdf"
                else:
                    mime_type = "image/jpeg"

                # OpenRouter / Gemini يقبل PDF وصور عبر image_url بنفس الأسلوب
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{base64_data}"},
                })
                print(f"AI: Sending file as multimodal ({mime_type})", flush=True)
            else:
                print("AI: Could not encode file to base64, sending text only.", flush=True)
        else:
            print("AI: No file path provided, sending text only.", flush=True)

        payload = {
            "model": ai_model,
            "messages": [
                {
                    "role": "user",
                    "content": content_parts,
                }
            ],
            "response_format": {"type": "json_object"},
            "max_tokens": 1000,
        }

        # Retry mechanism for 429 (Rate Limit)
        max_retries = 2
        response = None
        for attempt in range(max_retries + 1):
            response = requests.post(
                url="https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                data=json.dumps(payload),
                timeout=45,
            )
            if response.status_code == 429:
                if attempt < max_retries:
                    wait_time = (attempt + 1) * 5
                    print(f"AI Rate Limited (429). Retrying in {wait_time}s...", flush=True)
                    time.sleep(wait_time)
                    continue
            break

        if response is None:
            print("AI: No response received after retries.", flush=True)
            return None

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
                    "governorate": r'"governorate"\s*:\s*"([^"]*)"',
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
            ai_data["governorate"] = strip_field_label(
                ai_data.get("governorate", ""), ["المحافظة", "محافظة", "governorate", "Governorate"]
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


def ai_detect_pdf_splits(file_path, filename):
    """Calls AI to detect if a PDF contains multiple documents and identify page ranges."""
    api_key_raw = os.environ.get("OPENROUTER_API_KEY")
    ai_model = os.environ.get("AI_MODEL", "google/gemini-2.5-flash-lite")

    if not api_key_raw:
        return None

    # Load Balancing
    api_keys = [k.strip() for k in api_key_raw.split(',') if k.strip()]
    api_key = random.choice(api_keys) if api_keys else None
    
    if not api_key:
        return None

    # 1. Gather Text Context (First 15 pages)
    text_context = ""
    num_pages = 0
    images_payload = []
    try:
        doc = fitz.open(file_path)
        num_pages = len(doc)
        for i in range(min(num_pages, 15)):
            page_text = doc[i].get_text().strip()
            text_context += f"--- Page {i+1} ---\n{page_text[:400]}\n"
            
            # Extract thumbnails for the first 8 pages for visual cues (headers/logos)
            if i < 8:
                pix = doc[i].get_pixmap(matrix=fitz.Matrix(0.4, 0.4))
                img_data = base64.b64encode(pix.tobytes("jpg")).decode("utf-8")
                images_payload.append(img_data)
        doc.close()
    except Exception as e:
        print(f"Error reading PDF for split detection: {e}", flush=True)

    prompt = f"""أنت خبير في تنظيم الأرشيف الإداري. مهمتك هي فحص ملف PDF وتحديد ما إذا كان يحتوي على عدة وثائق مستقلة (مثل خطابات منفصلة، قرارات، تقارير، أو مشاريع مختلفة) مجمعة في ملف واحد.
    
    اسم الملف: {filename}
    عدد الصفحات: {num_pages}
    
    محتوى النص المستخرج (عينة):
    {text_context}
    
    المطلوب:
    1. حدد ما إذا كان الملف يحتاج لتقسيم إلى وثائق منفصلة.
    2. لكل وثيقة مستقلة، استخرج موضوعاً دقيقاً ومختصراً (Subject) يعبر عن محتواها (بعنوان الخطاب أو الجواب).
    3. حدد نطاق الصفحات (البداية والنهاية) لكل وثيقة.
    
    أرجع النتيجة بصيغة JSON فقط كقائمة من الكائنات:
    [
      {{
        "subject": "موضوع الوثيقة الأولى بدقة (مثال: خطاب وزارة المالية بشأن الميزانية)",
        "pages": [1, 2] 
      }},
      {{
        "subject": "موضوع الوثيقة الثانية بدقة (مثال: محضر اجتماع اللجنة الفنية)",
        "pages": [3, 4, 5]
      }}
    ]
    
    قواعد هامة:
    1. إذا كان الملف وثيقة واحدة متصلة فقط، أرجع قائمة فارغة [].
    2. تأكد أن أرقام الصفحات (1-indexed) تغطي كامل الملف بالتسلسل ولا تتداخل.
    3. ابحث عن الترويسات (Headers) الجديدة، التواقيع، أو تغيير المواضيع كعلامات للفصل.
    4. اجعل الموضوع (subject) مناسباً ليكون اسماً للملف لاحقاً.
    """

    try:
        # Build multimodal payload with thumbnails
        content_list = [{"type": "text", "text": prompt}]
        for img_b64 in images_payload:
            content_list.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}
            })

        payload = {
            "model": ai_model,
            "messages": [{"role": "user", "content": content_list}],
            "response_format": {"type": "json_object"},
        }

        response = requests.post(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            data=json.dumps(payload),
            timeout=50,
        )

        if response.status_code == 200:
            result = response.json()
            raw_content = result["choices"][0]["message"]["content"]
            
            # Robust extraction
            def extract_split_json(text):
                try:
                    # Find potential JSON block using regex if wrapped in markdown
                    json_match = re.search(r"\[.*\]", text, re.DOTALL)
                    if json_match:
                        return json.loads(json_match.group(0))
                except: pass
                
                # Check for object wrap
                try:
                    obj = json.loads(text)
                    if isinstance(obj, dict) and "documents" in obj: return obj["documents"]
                    if isinstance(obj, dict) and "splits" in obj: return obj["splits"]
                    if isinstance(obj, list): return obj
                except: pass
                
                return []

            return extract_split_json(raw_content)
    except Exception as e:
        print(f"AI Split Detection Failed: {e}", flush=True)

    return None


def split_pdf_file(file_path, split_data):
    """Splits a PDF into multiple files based on page ranges."""
    split_files = []
    try:
        doc = fitz.open(file_path)
        base_dir = os.path.dirname(file_path)
        
        for i, item in enumerate(split_data):
            pages = item.get("pages", [])
            if not pages: continue
            
            new_doc = fitz.open()
            # Handle pages list [1, 2, 3] or [start, end]
            if len(pages) > 2 or (len(pages) == 2 and pages[1] == pages[0] + 1):
                for p in pages:
                    if 1 <= p <= len(doc):
                        new_doc.insert_pdf(doc, from_page=p-1, to_page=p-1)
            else:
                # Assume [start, end]
                start = max(1, pages[0])
                end = min(len(doc), pages[-1])
                new_doc.insert_pdf(doc, from_page=start-1, to_page=end-1)
            
            # Sanitize subject for temporary filename
            subject_raw = item.get("subject", f"Document_{i+1}")
            safe_subject = sanitize_folder_name(subject_raw)
            
            # Use the subject as the filename directly as requested
            # We add a small random part to avoid collisions during the split process in the watch folder
            rand_id = random.randint(100, 999)
            output_filename = f"{safe_subject}_{rand_id}.pdf"
            output_path = os.path.join(base_dir, output_filename)
            
            new_doc.save(output_path)
            new_doc.close()
            split_files.append(output_path)
            print(f"Created split part: {output_path}", flush=True)
            
        doc.close()
    except Exception as e:
        print(f"Error splitting PDF: {e}", flush=True)
        
    return split_files


def mock_ai_analyze(text, filename):
    """Fallback logic if real AI fails, or if Auto-Analysis is disabled."""
    ext = os.path.splitext(filename)[1].lower()
    file_format = "PDF" if ext == ".pdf" else "IMAGE"

    # Format filename into a readable title
    raw_name = os.path.splitext(filename)[0]
    readable_title = raw_name.replace("_", " ").replace("-", " ").title()

    return {
        "title": readable_title,
        "subject": readable_title,   # FIX: use readable title so file gets moved & renamed
        "project": "غير_محدد",       # FIX: explicit fallback so organize_file_copy always has a project
        "governorate": "غير_محددة",
        "doc_date": "",
        "version_no": "",
        "type": file_format,
        "class": "أخرى",
        "area": "",
        "tags": [],
        "summary": "تمت الإضافة بدون تحليل (الذكاء الاصطناعي مغلق). يرجى التعديل يدوياً.",
    }


def sanitize_folder_name(name):
    """Removes invalid characters and normalizes Arabic text to NFC."""
    if not name:
        return "غير_محدد"
    # Normalize to NFC to prevent duplicate folders with different encoding
    name = unicodedata.normalize("NFC", str(name))
    cleaned = re.sub(r'[<>:"/\\|?*]', "", name).strip()
    return cleaned or "غير_محدد"


def normalize_arabic_for_match(text):
    """Normalizes Arabic text for comparison - keeps it simple to avoid over-matching."""
    if not text:
        return ""
    # Normalize to NFC and lowercase
    text = unicodedata.normalize("NFC", str(text)).lower().strip()
    
    # Character normalization only:
    # 1. Alif (أ إ آ -> ا)
    text = re.sub("[إأآ]", "ا", text)
    # 2. Taa Marbuta vs Haa (ة -> ه)
    text = re.sub("ة", "ه", text)
    # 3. Yaa vs Alif Maksura (ى -> ي)
    text = re.sub("ى", "ي", text)
    
    # 4. Remove punctuation and symbols (e.g., - _ / \ | . ,)
    text = re.sub(r'[^\w\s]', ' ', text)
    
    # 5. Normalize " و " (waw as separator) - even if attached to the next word
    text = re.sub(r'\s+و(\w)', r' \1', text)
    text = re.sub(r'\s+و\s+', ' ', text)
    
    # 6. Remove common descriptive words
    common_words = ["مشروع", "عمليه", "دراسه", "خطاب", "بشان", "تقرير", "مذكره", "ملف"]
    for word in common_words:
        text = re.sub(r'\b' + word + r'\b', '', text)
    
    # 7. Professional Word Normalization:
    words = text.split()
    final_words = []
    for w in words:
        if len(w) > 3 and w.startswith("ال"):
            w = w[2:]
        if w:
            final_words.append(w)
    
    final_words.sort()
    text = " ".join(final_words)
    
    # Remove ONLY extra whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


def find_smart_project_match(new_project, year_path, use_fuzzy=True):
    """
    Finds the best existing project folder match.

    use_fuzzy=True  (Smart Matching ON):
        - Exact normalized match  → merge silently
        - Substring / fuzzy match → merge silently (AI decides)

    use_fuzzy=False (Smart Matching OFF):
        - Exact normalized match  → merge silently (same name = same folder)
        - ANY similarity (substring OR fuzzy ≥ 0.45) → ask user for confirmation
        - No similarity → create new folder
    """
    FUZZY_AUTO_THRESHOLD    = 0.80   # Smart ON:  auto-merge if score ≥ this
    FUZZY_CONFIRM_THRESHOLD = 0.25   # Smart OFF: ask user if score ≥ this

    if not os.path.exists(year_path):
        return sanitize_folder_name(new_project)

    existing_dirs = [d for d in os.listdir(year_path)
                     if os.path.isdir(os.path.join(year_path, d))]
    if not existing_dirs:
        return sanitize_folder_name(new_project)

    new_norm = normalize_arabic_for_match(new_project)
    if not new_norm:
        return sanitize_folder_name(new_project)

    best_match = None
    highest_score = 0.0
    substring_match = None   # first substring hit

    for d in existing_dirs:
        d_norm = normalize_arabic_for_match(d)
        if not d_norm:
            continue

        # ── 1. Exact normalized match (always silent) ──────────────────────
        if new_norm == d_norm:
            print(f"Smart Match: Exact match '{new_project}' -> '{d}'", flush=True)
            return d

        # ── 1.5. Substring Match (Case: "نوف وعين" inside "مشروع تطوير نوف وعين") ──
        if len(new_norm) >= 4 and len(d_norm) >= 4:
            if (new_norm in d_norm) or (d_norm in new_norm):
                # Calculate coverage ratio
                shorter_len = min(len(new_norm), len(d_norm))
                longer_len = max(len(new_norm), len(d_norm))
                if (shorter_len / longer_len) >= 0.5: # 50% coverage for substring
                    print(f"Smart Match: Substring match '{new_project}' <-> '{d}'", flush=True)
                    return d

        # ── 2. Fuzzy score check ──────────────────────────────────────────
        score = difflib.SequenceMatcher(None, new_norm, d_norm).ratio()
        if score > highest_score:
            highest_score = score
            best_match = d

    # ── Decision ────────────────────────────────────────────────────────────
    if use_fuzzy:
        # Smart Matching ON: merge automatically when confident
        if highest_score >= FUZZY_AUTO_THRESHOLD:
            print(f"Smart Match (auto): fuzzy {highest_score:.2f} '{new_project}' -> '{best_match}'", flush=True)
            return best_match
        
        # If not highly confident, just create a new folder
        return sanitize_folder_name(new_project)
    else:
        # Smart Matching OFF: ask user if there's any notable similarity
        if highest_score >= FUZZY_CONFIRM_THRESHOLD:
            print(f"Smart Match (confirm needed): '{new_project}' similar to '{best_match}' (score: {highest_score:.2f})", flush=True)
            return {"needs_confirmation": True, "similar": best_match, "new": sanitize_folder_name(new_project)}
        return sanitize_folder_name(new_project)


def organize_file_copy(doc_data, base_archive_path, smart_match=True):
    """
    Creates a hierarchical copy of the file: Year / Project / File
    هيكل المجلدات: السنة / المشروع / الملف
    - إذا كان الموضوع فارغاً → يُسمى الملف باسمه الأصلي ويُوضع في مجلد 'غير_محدد'
    - إذا كان المشروع فارغاً أو 'عام' → يُوضع في مجلد 'عام' تحت السنة
    """
    try:
        # ── 1. استخراج السنة ───────────────────────────────────────────────
        doc_date = doc_data.get("doc_date") or ""
        year = (
            doc_date.split("-")[0]
            if doc_date and "-" in doc_date and len(doc_date) >= 4
            else datetime.datetime.now().strftime("%Y")
        )

        # ── 2. تحديد اسم المشروع مع Fallback واضح ─────────────────────────
        project_raw = (doc_data.get("project") or "").strip()

        # "عام"       = AI صنّف الوثيقة صراحةً كـ عامة → مجلد "عام" (سلوك مقصود)
        # ""/"غير محدد" = فشل التحليل أو لا مشروع → مجلد "غير_محدد"
        TRULY_UNKNOWN_VALUES = {"", "غير محدد", "غير_محدد", "n/a", "unknown"}
        GENERAL_VALUES       = {"عام"}

        if project_raw.lower() in TRULY_UNKNOWN_VALUES:
            # فشل التحليل → مجلد "غير_محدد"
            project = "غير_محدد"
            print(f"Organize: No project detected, placing in 'غير_محدد'", flush=True)
        elif project_raw.lower() in GENERAL_VALUES:
            # وثيقة عامة مقصودة → مجلد "عام"
            project = "عام"
            print(f"Organize: General document, placing in 'عام'", flush=True)
        else:
            # ── 3. بناء مسار السنة للبحث عن مجلد مطابق ─────────────────────
            year_dir = os.path.join(base_archive_path, year)
            os.makedirs(year_dir, exist_ok=True)
            
            # ── 3.1. تحديد المحافظة ──────────────────────────────────────────
            gov_raw = (doc_data.get("governorate") or "").strip()
            if gov_raw.lower() in TRULY_UNKNOWN_VALUES:
                governorate = "غير_محددة"
            else:
                governorate = sanitize_folder_name(gov_raw)
            
            gov_dir = os.path.join(year_dir, governorate)
            os.makedirs(gov_dir, exist_ok=True)

            project = find_smart_project_match(project_raw, gov_dir, use_fuzzy=smart_match)
            if isinstance(project, dict) and project.get("needs_confirmation"):
                # Pass governorate back in the needs_confirmation dict if needed
                project["governorate"] = governorate
                return project
            print(f"Organize: Project resolved to '{project}' (from '{project_raw}') in Gov '{governorate}'", flush=True)

        # ── 4. بناء مسار المجلد الهدف ──────────────────────────────────────
        # الهيكل الجديد: السنة / المحافظة / المشروع
        if project in ("عام", "غير_محدد"):
             # For general/unknown projects, we might skip the governorate level or keep it
             # Let's keep it consistent: Year / Governorate / Project
             target_dir = os.path.join(base_archive_path, year, governorate if 'governorate' in locals() else "غير_محددة", project)
        else:
             target_dir = os.path.join(base_archive_path, year, governorate, project)
        
        os.makedirs(target_dir, exist_ok=True)

        # ── 5. تحديد اسم الملف الجديد من "الموضوع" ────────────────────────
        subject_raw = (doc_data.get("subject") or "").strip()
        UNKNOWN_SUBJECT_VALUES = {"", "غير محدد", "غير_محدد", "وثيقة_غير_معروفة", "n/a", "unknown"}
        if subject_raw.lower() in UNKNOWN_SUBJECT_VALUES:
            # لا يوجد موضوع → استخدم اسم الملف الأصلي بدون امتداد
            original_name = os.path.splitext(doc_data.get("file", "document"))[0]
            clean_subject = sanitize_folder_name(original_name) or "وثيقة_غير_معروفة"
            print(f"Organize: No subject detected, using original filename '{clean_subject}'", flush=True)
        else:
            clean_subject = sanitize_folder_name(subject_raw)

        # ── 6. الاحتفاظ بالامتداد الأصلي ──────────────────────────────────
        ext = os.path.splitext(doc_data.get("file", ".pdf"))[1]
        if not ext:
            ext = ".pdf"

        # ── 7. بناء اسم الملف النهائي ──────────────────────────────────────
        new_filename = f"{clean_subject}{ext}"
        target_file_path = os.path.join(target_dir, new_filename)

        # ── 8. معالجة تعارض الأسماء ────────────────────────────────────────
        if os.path.exists(target_file_path):
            # تحقق أولاً: هل الملف الموجود هو نفس الملف المصدر بالمحتوى؟
            source_path_check = doc_data.get("file_path")
            if source_path_check and os.path.exists(source_path_check):
                try:
                    existing_hash = get_file_hash(target_file_path)
                    source_hash   = get_file_hash(source_path_check)
                    if existing_hash == source_hash:
                        # نفس المحتوى → احذف المصدر المكرر واستخدم الموجود
                        if os.path.abspath(source_path_check) != os.path.abspath(target_file_path):
                            os.remove(source_path_check)
                            print(f"Deduplicated: Removed duplicate source, using existing: {target_file_path}", flush=True)
                        return target_file_path
                except Exception:
                    pass
            # مختلف المحتوى → أضف suffix
            unique_suffix = int(time.time()) % 10000
            new_filename = f"{clean_subject}_{unique_suffix}{ext}"
            target_file_path = os.path.join(target_dir, new_filename)

        # ── 9. نقل الملف الأصلي ────────────────────────────────────────────
        source_path = doc_data.get("file_path")
        if source_path and os.path.exists(source_path):
            if source_path != target_file_path:
                shutil.move(source_path, target_file_path)
                print(f"File moved to: {target_file_path}", flush=True)
                
                # تنظيف المجلدات الفارغة بعد النقل
                source_dir = os.path.dirname(source_path)
                cleanup_empty_dirs(source_dir, base_archive_path)
            else:
                print(f"File already at target: {target_file_path}", flush=True)
        else:
            print(f"WARNING: Source file not found: {source_path}", flush=True)
            return None

        return target_file_path

    except Exception as e:
        print(f"Error organizing file copy: {e}", flush=True)
        import traceback
        traceback.print_exc()

    return None


def process_file(file_path, output_folder, skip_ai=False, force_reprocess=False, doc_id=None, split_pdf=False, smart_match=True):
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
    
    # Try to recover doc_id from sidecar if not provided
    if not doc_id and os.path.exists(sidecar_path):
        try:
            with open(sidecar_path, 'r', encoding='utf-8') as f:
                temp_data = json.load(f)
                doc_id = temp_data.get('id')
        except: pass

    if not force_reprocess and os.path.exists(sidecar_path):
        print(f"Smart Skip: Sidecar already exists next to file: {file_name}", flush=True)
        # Recover ID if possible to signal completion
        recovered_id = doc_id
        if not recovered_id:
            try:
                with open(sidecar_path, 'r', encoding='utf-8') as f:
                    recovered_id = json.load(f).get('id')
            except: pass
        
        if recovered_id:
            print(json.dumps({"type": "sync_complete", "doc_id": recovered_id}, ensure_ascii=False), flush=True)
            report_status("status_idle", 100, doc_id=recovered_id)
        return None

    # 2. Check content fingerprint (SHA256) in Database (Deeper Skip)
    file_hash = get_file_hash(file_path)
    existing_doc = get_document_by_sha256(file_hash)
    
    # Pre-determine file_id for status reporting
    if doc_id:
        file_id = doc_id
    elif existing_doc:
        file_id = existing_doc.get("id")
    else:
        normalized_name = unicodedata.normalize("NFC", file_name)
        file_id = hashlib.sha256(normalized_name.encode("utf-8")).hexdigest()[:24]

    if not force_reprocess and existing_doc:
        # لا نتخطى الملف إذا كان موجوداً في مجلد "غير_محدد" بسبب فشل سابق في التحليل
        # نعيد معالجته لكي يُصنَّف في المكان الصحيح
        existing_path = existing_doc.get("file_path", "")
        in_fallback_folder = (
            os.sep + "غير_محدد" + os.sep in existing_path or
            existing_path.endswith(os.sep + "غير_محدد") or
            os.sep + "غير محدد" + os.sep in existing_path
        )
        if in_fallback_folder:
            print(f"Re-processing: Document was in fallback folder, attempting proper classification: {file_hash[:8]}", flush=True)
            # Allow processing to continue (don't return None)
        else:
            print(f"Smart Skip: Document already archived with hash {file_hash[:8]}", flush=True)
            # Still need to signal completion for UI counters
            print(json.dumps({"type": "sync_complete", "doc_id": file_id}, ensure_ascii=False), flush=True)
            report_status("status_idle", 100, doc_id=file_id)
            return None

    # 3. PDF Splitting Logic
    if ext == ".pdf" and split_pdf and not skip_ai:
        print(f"Checking if PDF needs splitting: {file_name}", flush=True)
        report_status("status_split_check", 5, doc_id=doc_id, extra={"file": file_name})
        split_data = ai_detect_pdf_splits(file_path, file_name)
        if split_data and len(split_data) > 1:
            print(f"AI detected {len(split_data)} documents in PDF. Splitting...", flush=True)
            report_status("status_splitting", 10, doc_id=doc_id)
            parts = split_pdf_file(file_path, split_data)
            if parts:
                # Move original to .original folder to avoid reprocessing and keep it safe
                original_dir = os.path.join(output_folder, ".original")
                os.makedirs(original_dir, exist_ok=True)
                dest_original = os.path.join(original_dir, file_name)
                
                # Collision handling for backup
                if os.path.exists(dest_original):
                    dest_original = os.path.join(original_dir, f"{int(time.time())}_{file_name}")
                
                shutil.move(file_path, dest_original)
                print(f"Original file moved to backup: {dest_original}", flush=True)
                
                # Delete original record from DB if it exists (created by main.js process-uploads)
                if doc_id:
                    print(f"Deleting original record for split file: {doc_id}", flush=True)
                    delete_document(doc_id)

                # Process each part individually
                for part in parts:
                    print(f"Analyzing split part: {os.path.basename(part)}", flush=True)
                    process_file(part, output_folder, skip_ai=skip_ai, force_reprocess=force_reprocess, split_pdf=False, smart_match=smart_match)
                
                report_status("status_idle", 100)
                return None # Finished processing parts

    print(f"Processing: {file_path}", flush=True)

    # 3. ID Resolution
    if not doc_id:
        # Unified ID generation using NFC normalization to match Electron
        normalized_name = unicodedata.normalize("NFC", file_name)
        file_id = hashlib.sha256(normalized_name.encode("utf-8")).hexdigest()[:24]
    else:
        file_id = doc_id

    report_status("status_processing", 10, doc_id=file_id, extra={"file": file_name})

    try:
        if ext == ".pdf":
            content = extract_text_from_pdf(file_path, doc_id=file_id)
        else:
            content = extract_text_from_image(file_path, doc_id=file_id)

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
        organized_path = organize_file_copy(doc_data, output_folder, smart_match=smart_match)
        
        if isinstance(organized_path, dict) and organized_path.get("needs_confirmation"):
            report_status("needs_confirmation", 90, doc_id=file_id, extra={
                "doc_data": doc_data,
                "similar": organized_path["similar"],
                "new_project": organized_path["new"]
            })
            return None # Let Node.js handle it after user confirmation

        # ── Critical: Only proceed if file was successfully organized ──────
        if not organized_path or not os.path.exists(organized_path):
            print(f"ERROR: File organization failed or file missing after move: {file_name}. Aborting archival.", flush=True)
            # Clean up any orphan sidecar that may have been left behind
            for stray_sidecar in [
                os.path.splitext(file_path)[0] + ".json",
                os.path.splitext(organized_path)[0] + ".json" if organized_path else None,
            ]:
                if stray_sidecar and os.path.exists(stray_sidecar):
                    try:
                        os.remove(stray_sidecar)
                        print(f"Cleaned up orphan sidecar: {stray_sidecar}", flush=True)
                    except Exception:
                        pass
            return None

        doc_data["file_path"] = organized_path
        doc_data["file"] = os.path.basename(organized_path)

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

        # ── تنظيف: إذا كان الملف موجوداً سابقاً في مجلد "غير_محدد" أو "عام"
        # بسبب فشل التحليل، نحذف تلك النسخة القديمة الآن بعد نجاح التصنيف ──────
        stale_dirs_to_check = []
        for year_dir in os.listdir(output_folder):
            year_path = os.path.join(output_folder, year_dir)
            if not os.path.isdir(year_path) or year_dir.startswith('.'):
                continue
            for fallback_name in ("غير_محدد", "غير محدد"):
                stale_dir = os.path.join(year_path, fallback_name)
                if os.path.isdir(stale_dir):
                    stale_dirs_to_check.append(stale_dir)

        for stale_dir in stale_dirs_to_check:
            for stale_file in os.listdir(stale_dir):
                if not stale_file.lower().endswith(('.pdf', '.jpg', '.jpeg', '.png', '.webp')):
                    continue
                stale_file_path = os.path.join(stale_dir, stale_file)
                # Skip the file we just organized (it may have moved here legitimately)
                if os.path.abspath(stale_file_path) == os.path.abspath(organized_path):
                    continue
                # Check SHA256 match
                try:
                    stale_hash = get_file_hash(stale_file_path)
                    if stale_hash == file_hash:
                        stale_json = os.path.splitext(stale_file_path)[0] + ".json"
                        os.remove(stale_file_path)
                        print(f"Cleanup: Removed stale fallback file: {stale_file_path}", flush=True)
                        if os.path.exists(stale_json):
                            os.remove(stale_json)
                            print(f"Cleanup: Removed stale fallback sidecar: {stale_json}", flush=True)
                        cleanup_empty_dirs(stale_dir, output_folder)
                except Exception as cleanup_err:
                    print(f"Cleanup warning: {cleanup_err}", flush=True)

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
        
        # Handle optional --id argument
        passed_id = None
        if "--id" in sys.argv:
            try:
                id_idx = sys.argv.index("--id")
                if len(sys.argv) > id_idx + 1:
                    passed_id = sys.argv[id_idx + 1]
            except: pass

        from db_manager import set_db_path
        set_db_path(output_folder_arg)
        try:
            # Force AI explicitly since this is a manual CLI invocation
            process_file(file_path_arg, output_folder_arg, skip_ai=False, force_reprocess=True, doc_id=passed_id)
        except Exception as e:
            print(f"CLI Processing error: {e}", flush=True)