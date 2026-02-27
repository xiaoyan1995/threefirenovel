from PIL import Image
import os

img_path = r"C:\Users\PKD\.gemini\antigravity\brain\261e0240-b95c-43c4-92e5-bf3c0e608dfa\yandraft_icon_final_1771679942700.png"
base_dir = r"h:\tools_by_threefire\多agent\小说创作\sanhuoai\src-tauri\icons"

if not os.path.exists(base_dir):
    os.makedirs(base_dir)

img = Image.open(img_path).convert("RGBA")

# Create standard icon sizes for Tauri
img.resize((32, 32)).save(os.path.join(base_dir, "32x32.png"))
img.resize((128, 128)).save(os.path.join(base_dir, "128x128.png"))
img.resize((256, 256)).save(os.path.join(base_dir, "128x128@2x.png"))

# Create .ico file with multiple sizes
img.save(
    os.path.join(base_dir, "icon.ico"),
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
)

# For .icns on macOS, we just save a high-res PNG and rename it
img.resize((512, 512)).save(os.path.join(base_dir, "icon.icns"))

print("Icons generated successfully in", base_dir)
