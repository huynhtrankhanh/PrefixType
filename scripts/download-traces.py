#!/usr/bin/env python3
"""Download the public trace corpus; originals stay outside version control."""
import concurrent.futures, hashlib, html, json, pathlib, re, urllib.request
FOLDER = 'https://drive.google.com/drive/folders/1Jw9isYHy7z-PFH5ucsfXvABQJV1QyPar'
def fetch(url):
    with urllib.request.urlopen(url, timeout=90) as r: return r.read()
def download(item):
    file_id, name = item
    name = html.unescape(name)
    data = fetch('https://drive.google.com/uc?export=download&id=' + file_id)
    if not data.startswith(b'PTBOX'): raise ValueError('Not a PTBOX file: ' + name)
    pathlib.Path('traces', name).write_bytes(data)
    return dict(name=name, id=file_id, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
if __name__ == '__main__':
    pathlib.Path('traces').mkdir(exist_ok=True)
    page = fetch(FOLDER).decode()
    files = dict(re.findall(r'data-id="([^\"]+)"[^>]+data-tooltip="([^\"]+\.ptbox) Binary"', page))
    if not files: raise ValueError('No trace files found')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        manifest = list(pool.map(download, files.items()))
    pathlib.Path('traces/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Downloaded', len(manifest), 'traces;', sum(f['bytes'] for f in manifest), 'bytes')
