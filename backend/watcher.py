import time
import os
import sys
import json
import unicodedata

# Force UTF-8 FIRST before any other imports that print
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from processor import process_file
from db_manager import initialize_db, rebuild_index, rebuild_index_recursive, set_db_path, get_db_path

# Processing lock: prevents the same file from being processed twice concurrently
_processing_lock = set()
# Cooldown cache: ignores repeated watchdog events for 30 seconds after processing
_recently_seen   = {}   # path -> timestamp
_COOLDOWN_SECS   = 30


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
        # 3. Skip if within cooldown window (Windows fires multiple events per move)
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
            process_file(src_path, self.folder_path)
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
            process_file(dest_path, self.folder_path)
        except Exception as e:
            print(f"Error processing {dest_path}: {e}", flush=True)
        finally:
            _processing_lock.discard(dest_path)

def start_watching(folder_path):
    # Set the dynamic database path before anything else
    set_db_path(folder_path)
    print(f"Python DB Path: {get_db_path()}", flush=True)
    print(f"Service started. Watching: {folder_path}", flush=True)
    
    # Check for API Key
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("CRITICAL WARNING: OPENROUTER_API_KEY is not found in the background environment!", flush=True)
    else:
        print(f"AI Engine Status: Active (Key found: {api_key[:4]}...{api_key[-4:]})", flush=True)
    
    # Initial sync: initialize DB and rebuild index from sidecars (recursive)
    initialize_db()
    rebuild_index_recursive(folder_path)
    
    # Now process any files that don't have a sidecar yet (existing unprocessed files)
    print("Scanning for unprocessed files...", flush=True)
    for root, dirs, files in os.walk(folder_path):
        # Skip hidden folders
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for filename in files:
            if filename.lower().endswith(('.pdf', '.jpg', '.jpeg', '.png', '.webp')):
                sidecar = os.path.splitext(filename)[0] + '.json'
                sidecar_path = os.path.join(root, sidecar)
                if not os.path.exists(sidecar_path):
                    print(f"Found unprocessed file: {filename} in {root}", flush=True)
                    try:
                        process_file(os.path.join(root, filename), folder_path)
                    except Exception as e:
                        print(f"Error processing {filename}: {e}", flush=True)
    
    print("Initial sync complete.", flush=True)
    # Signal Electron that the initial sync is done
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
    watch_folder = os.path.abspath(os.path.join(os.getcwd(), 'MAIN Archiva'))
    
    if len(sys.argv) > 1:
        if sys.argv[1] == '--import':
            # Mode: import external folder
            if len(sys.argv) > 2:
                external_folder = os.path.abspath(sys.argv[2])
                main_folder = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else watch_folder
                import_external_folder(external_folder, main_folder)
            else:
                print("Error: --import requires a folder path", flush=True)
        else:
            watch_folder = os.path.abspath(sys.argv[1])
            if not os.path.exists(watch_folder):
                os.makedirs(watch_folder)
            start_watching(watch_folder)
    else:
        if not os.path.exists(watch_folder):
            os.makedirs(watch_folder)
        start_watching(watch_folder)
