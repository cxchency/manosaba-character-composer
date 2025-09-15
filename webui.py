from flask import Flask, send_from_directory, render_template
from pathlib import Path
import json
from config.settings import BASE_DIR, PROFILE_DIR, HOST, PORT
BASE_DIR = Path(BASE_DIR)
PROFILE_DIR = Path(PROFILE_DIR)

app = Flask(__name__, static_folder="static", template_folder="templates")

def get_data_dir(character):
    return BASE_DIR / character

@app.route("/")
def home():
    allowed_characters = ["alisa", "anan", "coco", "ema", "hanna", "hiro", "leia", "margo", "meruru", "miria", "nanoka", "noah", "sherry"]
    characters = []
    if BASE_DIR.exists():
        for item in BASE_DIR.iterdir():
            if item.is_dir():
                character_name = item.name
                if character_name in allowed_characters:
                    profile_path = PROFILE_DIR / f"Profile_{character_name.capitalize()}.webp"
                    profile_url = f"/api/profile/{character_name}" if profile_path.exists() else "/static/default.webp"
                    characters.append({"name": character_name, "profile": profile_url})
    return render_template("home.html", characters=characters)

@app.route("/character/<character>")
def character_page(character):
    data_dir = get_data_dir(character)
    json_path = data_dir / "GameObject.json"
    if json_path.exists():
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        root_node = list(data.values())[0]
        return render_template("character.html", character=character, root_node=root_node)
    else:
        return "Character not found", 404

@app.route("/api/profile/<character>")
def get_profile(character):
    profile_path = PROFILE_DIR / f"Profile_{character.capitalize()}.webp"
    if profile_path.exists():
        return send_from_directory(PROFILE_DIR, f"Profile_{character.capitalize()}.webp")
    return "Not Found", 404

@app.route("/images/character/<character>/<path:path>")
def get_image(character, path):
    data_dir = get_data_dir(character)
    img_path = data_dir / path
    if not img_path.exists():
        return "Not Found", 404
    return send_from_directory(data_dir, path)

if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=True)
