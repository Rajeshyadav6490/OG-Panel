# OG Panel - Standalone Version

Files:
- `index.html` — main page
- `css/style.css` — styles
- `js/main.js` — frontend logic
- `js/mock-backend.js` — browser mock backend (uses localStorage)
- `app.py` — Flask backend (optional, for Python server)
- `requirements.txt` — Python dependencies

## Option 1: Open directly in browser (mock backend)
Just open `index.html` in a browser. All data is saved in localStorage by `js/mock-backend.js`.

## Option 2: Run Python Flask backend
```bash
pip install -r requirements.txt
python app.py
```
Then open: http://127.0.0.1:5000

Data is saved in the `data/` folder.
