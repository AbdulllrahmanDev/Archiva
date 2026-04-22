import sqlite3
import os
import json
import re
import sys
import ctypes

# Global configuration for the database path
DB_CONFIG = {
    "path": os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'Archiva Data', 'archiva.db'))
}

def set_db_path(folder_path):
    """Sets the database path to be inside the specified folder."""
    DB_CONFIG["path"] = os.path.join(os.path.abspath(folder_path), 'archiva.db')
    print(f"Database path set to: {DB_CONFIG['path']}", flush=True)

def get_db_path():
    """Returns the current database path."""
    return DB_CONFIG["path"]

def get_connection():
    """Returns a new sqlite3 connection to the current database path."""
    return sqlite3.connect(get_db_path())

def hide_file(path):
    """Sets the hidden attribute on a file (Windows only)."""
    if sys.platform == "win32" and os.path.exists(path):
        try:
            # 0x02 is the attribute for HIDDEN
            ctypes.windll.kernel32.SetFileAttributesW(path, 0x02)
        except Exception as e:
            print(f"Error hiding file {path}: {e}", flush=True)

def initialize_db():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            file_path TEXT,
            title TEXT,
            date_added TEXT,
            type TEXT,
            class TEXT,
            area TEXT,
            tags TEXT,
            summary TEXT,
            content TEXT,
            sha256 TEXT,
            status TEXT DEFAULT 'ready'
        )
    ''')
    
    # Migration: Add columns if they don't exist (safe for older DBs)
    for col in ['file', 'class', 'area', 'sha256', 'status', 'subject', 'project', 'doc_date', 'version_no', 'summary', 'intel_card']:
        try:
            cursor.execute(f"ALTER TABLE documents ADD COLUMN {col} TEXT")
        except:
            pass  # Column already exists
        
    conn.commit()
    conn.close()
    hide_file(get_db_path())

def update_manifest(folder_path):
    """Generates a manifest.json file in the folder for portability."""
    docs = get_all_documents()
    manifest_path = os.path.join(folder_path, 'manifest.json')
    try:
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(docs, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error updating manifest: {e}", flush=True)

def add_document(doc_data):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO documents (id, file, file_path, title, date_added, type, class, area, tags, summary, content, sha256, status, subject, project, doc_date, version_no, intel_card)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        doc_data['id'],
        doc_data.get('file', ''),
        doc_data.get('file_path', ''),
        doc_data.get('title', ''),
        doc_data.get('date_added', ''),
        doc_data.get('type', 'document'),
        doc_data.get('class', 'General'),
        doc_data.get('area', 'Unknown'),
        ','.join(doc_data['tags']) if isinstance(doc_data.get('tags'), list) else doc_data.get('tags', ''),
        doc_data.get('summary', ''),
        doc_data.get('content', ''),
        doc_data.get('sha256', ''),
        doc_data.get('status', 'ready'),
        doc_data.get('subject', ''),
        doc_data.get('project', ''),
        doc_data.get('doc_date', ''),
        doc_data.get('version_no', ''),
        doc_data.get('intel_card', '')
    ))
    conn.commit()
    conn.close()

def parse_json_sidecar(file_path):
    """Parses a .json sidecar file and returns a doc_data dict."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data
    except Exception as e:
        print(f"Error parsing JSON sidecar {file_path}: {e}", flush=True)
        return None

def rebuild_index(folder_path):
    """Scans the folder (non-recursive) for .json sidecar files and updates the DB."""
    if not os.path.exists(folder_path):
        print(f"Index rebuild skipped: {folder_path} does not exist", flush=True)
        return

    print(f"Rebuilding index from: {folder_path}", flush=True)
    count = 0
    for filename in os.listdir(folder_path):
        if filename in ('manifest.json',):
            continue
        if filename.endswith('.json'):
            sidecar_path = os.path.join(folder_path, filename)
            doc_data = parse_json_sidecar(sidecar_path)
            if doc_data and doc_data.get('id'):
                original_file = doc_data.get('file', '')
                if original_file and not doc_data.get('file_path'):
                    doc_data['file_path'] = os.path.join(folder_path, original_file)
                if not doc_data.get('content'):
                    doc_data['content'] = doc_data.get('content_preview', '')
                try:
                    add_document(doc_data)
                    count += 1
                except Exception as e:
                    print(f"Failed to add document {filename}: {e}", flush=True)
    print(f"Index rebuild complete. Added {count} documents.", flush=True)

def rebuild_index_recursive(folder_path):
    """
    Scans the folder RECURSIVELY for .json sidecar files and updates the DB.
    This is the 'memory' feature - any folder dropped in will be recognized
    immediately from its sidecar JSON files without reprocessing.
    """
    if not os.path.exists(folder_path):
        print(f"Recursive index rebuild skipped: {folder_path} does not exist", flush=True)
        return

    print(f"Rebuilding index recursively from: {folder_path}", flush=True)
    count = 0
    for root, dirs, files in os.walk(folder_path):
        # Skip hidden directories
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for filename in files:
            if filename in ('manifest.json',):
                continue
            if filename.endswith('.json'):
                sidecar_path = os.path.join(root, filename)
                doc_data = parse_json_sidecar(sidecar_path)
                if doc_data and doc_data.get('id'):
                    original_file = doc_data.get('file', '')
                    # Resolve file_path: use stored or reconstruct from sidecar location
                    stored_path = doc_data.get('file_path', '')
                    if stored_path and os.path.exists(stored_path):
                        pass  # Keep stored path as-is
                    elif original_file:
                        # Try to find the file next to the sidecar
                        candidate = os.path.join(root, original_file)
                        if os.path.exists(candidate):
                            doc_data['file_path'] = candidate
                    if not doc_data.get('content'):
                        doc_data['content'] = doc_data.get('content_preview', '')
                    try:
                        add_document(doc_data)
                        count += 1
                    except Exception as e:
                        print(f"Failed to add document {filename}: {e}", flush=True)
    print(f"Recursive index rebuild complete. Added {count} documents.", flush=True)

def get_all_documents():
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM documents ORDER BY date_added DESC')
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_document_by_sha256(sha256):
    """Checks if a document with the same content hash already exists."""
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM documents WHERE sha256 = ?', (sha256,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def delete_document(doc_id):
    """Deletes a document record from the database by ID."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM documents WHERE id = ?', (doc_id,))
    conn.commit()
    conn.close()

if __name__ == '__main__':
    initialize_db()
    print("Database initialized.", flush=True)
