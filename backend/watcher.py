import time
import os
import sys
import json
import unicodedata
import hashlib

# Force UTF-8 FIRST before any other imports that print
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from processor import process_file
from db_manager import initialize_db, rebuild_index, rebuild_index_recursive, set_db_path, get_db_path, get_document_status

# Processing lock: prevents the same file from being processed twice concurrently
_processing_lock = set()
# Cooldown cache: ignores repeated watchdog events for 30 seconds after processing
_recently_seen   = {}   # path -> timestamp
_COOLDOWN_SECS   = 30

# ============================================================
# AUTO-ANALYSIS CONFIGURATION  (Sentinel File System)
# ============================================================
# The state is controlled by sentinel files written by main.js.
# This allows live enable/disable WITHOUT restarting the process.
# Fallback: read ENV vars set at process spawn time.

_WATCH_FOLDER = os.environ.get('ARCHIVA_WATCH_FOLDER', '')

# ENV-based fallbacks (used at first startup before any sentinel is written)
_ENV_AUTO_ENABLED = os.environ.get('AUTO_ANALYSIS_ENABLED', '1') == '1'
_ENV_ACTIVATED_AT = os.environ.get('AUTO_ANALYSIS_ACTIVATED_AT', '')

def _sentinel_dir():
    folder = _WATCH_FOLDER or os.getcwd()
    return os.path.join(folder, '.archiva')

def _read_sentinel_enabled():
    """Read live auto-analysis state from sentinel file."""
    enabled_file = os.path.join(_sentinel_dir(), 'auto_analysis_enabled')
    if os.path.exists(enabled_file):
        try:
            return open(enabled_file, 'r', encoding='utf-8').read().strip() == '1'
        except Exception:
            pass
    return _ENV_AUTO_ENABLED  # Fallback to startup ENV
def _read_sentinel_split_enabled():
    """Read live pdf splitting state from sentinel file."""
    split_file = os.path.join(_sentinel_dir(), 'pdf_split_enabled')
    if os.path.exists(split_file):
        try:
            return open(split_file, 'r', encoding='utf-8').read().strip() == '1'
        except Exception:
            pass
    return os.environ.get('PDF_SPLIT_ENABLED', '0') == '1' # Fallback to startup ENV

def _read_sentinel_smart_match_enabled():
    """Read live smart project matching state from sentinel file."""
    smart_file = os.path.join(_sentinel_dir(), 'smart_project_matching')
    if os.path.exists(smart_file):
        try:
            return open(smart_file, 'r', encoding='utf-8').read().strip() == '1'
        except Exception:
            pass
    return os.environ.get('SMART_PROJECT_MATCHING', '1') == '1' # Default true

def _read_sentinel_timestamp():
    """Read live activation timestamp from sentinel file. Returns Unix float or None."""
    ts_file = os.path.join(_sentinel_dir(), 'activation_timestamp')
    if os.path.exists(ts_file):
        try:
            ts_str = open(ts_file, 'r', encoding='utf-8').read().strip()
            if ts_str:
                import datetime
                dt = datetime.datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                return dt.timestamp()
        except Exception as e:
            print(f"Warning: Could not parse activation timestamp from sentinel: {e}", flush=True)
        return None
    # Fallback to ENV-based timestamp
    if _ENV_ACTIVATED_AT:
        try:
            import datetime
            dt = datetime.datetime.fromisoformat(_ENV_ACTIVATED_AT.replace('Z', '+00:00'))
            return dt.timestamp()
        except Exception:
            pass
    return None


class ArchiveHandler(FileSystemEventHandler):
    def __init__(self, folder_path):
        self.folder_path = os.path.abspath(folder_path)

    def _should_process(self, path):
        """Returns True only if the path is a media file that should be processed."""
        # 1. Only handle known media types — ignore .json, .db, .tmp etc.
        if not path.lower().endswith(('.pdf', '.jpg', '.jpeg', '.png', '.webp')):
            return False
        # 2. Skip if already being processed concurrently
        if path in _processing_lock:
            return False
        # 4. Skip if within cooldown window (Windows fires multiple events per move)
        last_seen = _recently_seen.get(path)
        if last_seen and (time.time() - last_seen) < _COOLDOWN_SECS:
            return False
        return True

    def _mark_seen(self, path):
        """Record that we just handled this path."""
        _recently_seen[path] = time.time()
        # Prune old entries to keep memory clean
        now = time.time()
        expired = [p for p, t in _recently_seen.items() if now - t > _COOLDOWN_SECS * 2]
        for p in expired:
            _recently_seen.pop(p, None)

    def on_created(self, event):
        if event.is_directory:
            return
        src_path = unicodedata.normalize('NFC', event.src_path)
        if not self._should_process(src_path):
            return
        self._mark_seen(src_path)  # Register immediately to block duplicate events
        time.sleep(1)  # Brief pause to ensure file is fully written
        _processing_lock.add(src_path)
        try:
            skip_ai = not _read_sentinel_enabled()
            
            # Check for force_ai override
            file_name = os.path.basename(src_path)
            normalized_name = unicodedata.normalize("NFC", file_name)
            file_id = hashlib.sha256(normalized_name.encode("utf-8")).hexdigest()[:24]
            sentinel_dir = os.path.join(self.folder_path, '.archiva')
            force_ai_file = os.path.join(sentinel_dir, f'force_ai_{file_id}.tmp')
            if os.path.exists(force_ai_file):
                skip_ai = False
                try: os.remove(force_ai_file)
                except: pass

            split_pdf = _read_sentinel_split_enabled()
            smart_match = _read_sentinel_smart_match_enabled()

            process_file(src_path, self.folder_path, skip_ai=skip_ai, split_pdf=split_pdf, smart_match=smart_match)
        except Exception as e:
            print(f"Error processing {src_path}: {e}", flush=True)
        finally:
            _processing_lock.discard(src_path)

    def on_moved(self, event):
        if event.is_directory:
            return
        src_path  = unicodedata.normalize('NFC', event.src_path)
        dest_path = unicodedata.normalize('NFC', event.dest_path)

        # KEY FIX: Ignore internal moves (organized by the processor itself).
        # If the SOURCE was already inside our watch folder, this is just
        # shutil.move() reorganising the file — not a new upload.
        src_abs  = os.path.abspath(src_path)
        src_base = os.path.abspath(self.folder_path)
        if src_abs.startswith(src_base + os.sep) or src_abs == src_base:
            return  # Internal move — nothing to do

        # External file moved/renamed into the watch folder
        if not self._should_process(dest_path):
            return
        self._mark_seen(dest_path)  # Register immediately to block duplicate events
        time.sleep(1)
        _processing_lock.add(dest_path)
        try:
            skip_ai = not _read_sentinel_enabled()
            
            # Check for force_ai override
            file_name = os.path.basename(dest_path)
            normalized_name = unicodedata.normalize("NFC", file_name)
            file_id = hashlib.sha256(normalized_name.encode("utf-8")).hexdigest()[:24]
            sentinel_dir = os.path.join(self.folder_path, '.archiva')
            force_ai_file = os.path.join(sentinel_dir, f'force_ai_{file_id}.tmp')
            if os.path.exists(force_ai_file):
                skip_ai = False
                try: os.remove(force_ai_file)
                except: pass

            split_pdf = _read_sentinel_split_enabled()
            smart_match = _read_sentinel_smart_match_enabled()

            # FINAL SAFETY CHECK: If status was set to 'stopped' by main.js (Force Stop), skip it.
            if get_document_status(file_id) == 'stopped':
                print(f"Skipping {file_name} because it was manually STOPPED.", flush=True)
                return

            process_file(dest_path, self.folder_path, skip_ai=skip_ai, split_pdf=split_pdf, smart_match=smart_match)
        except Exception as e:
            print(f"Error processing {dest_path}: {e}", flush=True)
        finally:
            _processing_lock.discard(dest_path)

def start_watching(folder_path):
    global _WATCH_FOLDER
    _WATCH_FOLDER = os.path.abspath(folder_path)

    # Set the dynamic database path before anything else
    set_db_path(folder_path)
    print(f"Python DB Path: {get_db_path()}", flush=True)
    print(f"Service started. Watching: {folder_path}", flush=True)

    # Bootstrap sentinel files from ENV vars if not yet written by main.js
    sentinel_dir = os.path.join(_WATCH_FOLDER, '.archiva')
    enabled_file = os.path.join(sentinel_dir, 'auto_analysis_enabled')
    ts_file      = os.path.join(sentinel_dir, 'activation_timestamp')
    if not os.path.exists(enabled_file):
        try:
            os.makedirs(sentinel_dir, exist_ok=True)
            with open(enabled_file, 'w', encoding='utf-8') as f:
                f.write('1' if _ENV_AUTO_ENABLED else '0')
            if _ENV_AUTO_ENABLED and _ENV_ACTIVATED_AT:
                with open(ts_file, 'w', encoding='utf-8') as f:
                    f.write(_ENV_ACTIVATED_AT)
            print(f"Bootstrapped sentinel files (enabled={_ENV_AUTO_ENABLED})", flush=True)
        except Exception as e:
            print(f"Warning: Could not bootstrap sentinel files: {e}", flush=True)

    enabled_now  = _read_sentinel_enabled()
    print(f"Auto-Analysis: {'ENABLED' if enabled_now else 'DISABLED'}", flush=True)
    activation_ts = _read_sentinel_timestamp()
    if activation_ts:
        import datetime
        activated_str = datetime.datetime.fromtimestamp(activation_ts).strftime('%Y-%m-%d %H:%M:%S')
        print(f"Activation Timestamp Gate: {activated_str} (files before this are ignored)", flush=True)
    
    # Check for API Key
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("CRITICAL WARNING: OPENROUTER_API_KEY is not found in the background environment!", flush=True)
    else:
        print(f"AI Engine Status: Active (Key found: {api_key[:4]}...{api_key[-4:]})", flush=True)
    
    # Initial sync: initialize DB and rebuild index from sidecars (recursive)
    initialize_db()
    rebuild_index_recursive(folder_path)

    # ── Cleanup: Remove orphan JSON sidecars (JSON exists but PDF/image is missing) ──
    print("Scanning for orphan JSON sidecars...", flush=True)
    orphans_removed = 0
    for root, dirs, files in os.walk(folder_path):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for filename in files:
            if filename.lower().endswith('.json'):
                json_path = os.path.join(root, filename)
                # Find the matching media file
                base = os.path.splitext(filename)[0]
                found_media = False
                for ext in ('.pdf', '.jpg', '.jpeg', '.png', '.webp'):
                    if os.path.exists(os.path.join(root, base + ext)):
                        found_media = True
                        break
                if not found_media:
                    try:
                        os.remove(json_path)
                        orphans_removed += 1
                        print(f"Removed orphan sidecar: {json_path}", flush=True)
                    except Exception as e:
                        print(f"Could not remove orphan sidecar {json_path}: {e}", flush=True)
    
    # Also remove empty project folders (folders with no media files at all)
    for root, dirs, files in os.walk(folder_path, topdown=False):
        for d in dirs:
            if d.startswith('.'):
                continue
            dir_path = os.path.join(root, d)
            try:
                has_media = any(
                    f.lower().endswith(('.pdf', '.jpg', '.jpeg', '.png', '.webp'))
                    for _, _, fs in os.walk(dir_path) for f in fs
                )
                if not has_media and not os.listdir(dir_path):
                    os.rmdir(dir_path)
                    print(f"Removed empty folder: {dir_path}", flush=True)
            except Exception:
                pass

    if orphans_removed:
        print(f"Cleanup complete: removed {orphans_removed} orphan sidecar(s).", flush=True)
    else:
        print("No orphan sidecars found.", flush=True)
    
    # Only scan for unprocessed files if auto-analysis is currently enabled
    if enabled_now:
        activation_ts = _read_sentinel_timestamp()
        print("Scanning for unprocessed files...", flush=True)
        for root, dirs, files in os.walk(folder_path):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for filename in files:
                if filename.lower().endswith(('.pdf', '.jpg', '.jpeg', '.png', '.webp')):
                    file_path = os.path.join(root, filename)
                    # Apply Timestamp Gate
                    if activation_ts is not None:
                        try:
                            if os.path.getctime(file_path) < activation_ts:
                                continue
                        except Exception:
                            pass
                    sidecar = os.path.splitext(filename)[0] + '.json'
                    sidecar_path = os.path.join(root, sidecar)
                    if not os.path.exists(sidecar_path):
                        print(f"Found unprocessed file: {filename} in {root}", flush=True)
                        try:
                            split_pdf = _read_sentinel_split_enabled()
                            smart_match = _read_sentinel_smart_match_enabled()
                            # In initial scan, if enabled_now is True, we use AI.
                            # We only run initial scan if enabled_now is True, so skip_ai is False.
                            process_file(os.path.join(root, filename), folder_path, skip_ai=False, split_pdf=split_pdf, smart_match=smart_match)
                        except Exception as e:
                            print(f"Error processing {filename}: {e}", flush=True)
    else:
        print("Auto-Analysis is DISABLED. Skipping initial scan.", flush=True)
    
    print("Initial sync complete.", flush=True)
    print(json.dumps({"type": "sync_complete"}, ensure_ascii=False), flush=True)

    event_handler = ArchiveHandler(folder_path)
    observer = Observer()
    observer.schedule(event_handler, folder_path, recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

def import_external_folder(external_folder, main_archive_folder):
    """
    Import an external folder into the archive by:
    1. Reading existing JSON sidecars (memory) - no reprocessing needed
    2. Processing PDF/image files that have no sidecar
    Results are added to the DB so they appear in the UI.
    """
    print(f"Importing external folder: {external_folder}", flush=True)
    set_db_path(main_archive_folder)
    initialize_db()
    
    # First pass: load existing JSON sidecars as memory
    rebuild_index_recursive(external_folder)
    
    # Second pass: process files without sidecars
    processed = 0
    for root, dirs, files in os.walk(external_folder):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for filename in files:
            if filename.lower().endswith(('.pdf', '.jpg', '.jpeg', '.png', '.webp')):
                sidecar = os.path.splitext(filename)[0] + '.json'
                sidecar_path = os.path.join(root, sidecar)
                if not os.path.exists(sidecar_path):
                    print(f"Processing new file from external: {filename}", flush=True)
                    try:
                        process_file(os.path.join(root, filename), external_folder)
                        processed += 1
                    except Exception as e:
                        print(f"Error processing {filename}: {e}", flush=True)
    
    print(f"External import complete. Processed {processed} new files.", flush=True)
    print(json.dumps({"type": "sync_complete"}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    # Get folder path from argument or default
    watch_folder = os.path.abspath(os.path.join(os.getcwd(), 'Archiva Data'))
    
    if len(sys.argv) > 1:
        if sys.argv[1] == '--import':
            # Mode: import external folder
            if len(sys.argv) > 2:
                external_folder = os.path.abspath(sys.argv[2])
                main_folder = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else watch_folder
                import_external_folder(external_folder, main_folder)
            else:
                print("Error: --import requires a folder path", flush=True)
        elif sys.argv[1] == '--process-file':
            # Mode: process a single file (used for manual reprocessing)
            if len(sys.argv) > 3:
                file_to_process = os.path.abspath(sys.argv[2])
                watch_folder = os.path.abspath(sys.argv[3])
                
                # Optional --id
                passed_id = None
                if "--id" in sys.argv:
                    try:
                        id_idx = sys.argv.index("--id")
                        if len(sys.argv) > id_idx + 1:
                            passed_id = sys.argv[id_idx + 1]
                    except: pass
                
                # Setup DB and process
                set_db_path(watch_folder)
                try:
                    # Force AI explicitly since this is a manual manual invocation
                    process_file(file_to_process, watch_folder, skip_ai=False, force_reprocess=True, doc_id=passed_id)
                except Exception as e:
                    print(f"Manual Processing error: {e}", flush=True)
            else:
                print("Error: --process-file requires <file_path> <watch_folder>", flush=True)
        else:
            watch_folder = os.path.abspath(sys.argv[1])
            if not os.path.exists(watch_folder):
                os.makedirs(watch_folder)
            start_watching(watch_folder)
    else:
        if not os.path.exists(watch_folder):
            os.makedirs(watch_folder)
        start_watching(watch_folder)