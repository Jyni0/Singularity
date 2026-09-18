import os
import base64
from PIL import Image

def generate_web_icons():
    os.makedirs('public', exist_ok=True)
    master = Image.open('app-icon.png')

    # Standard favicon & PWA sizes
    sizes = {
        'favicon-16x16.png': (16, 16),
        'favicon-32x32.png': (32, 32),
        'apple-touch-icon.png': (180, 180),
        'icon-192.png': (192, 192),
        'icon-512.png': (512, 512),
        'app-icon.png': (1024, 1024),
    }

    for filename, size in sizes.items():
        resized = master.resize(size, Image.Resampling.LANCZOS)
        resized.save(os.path.join('public', filename), 'PNG', optimize=True)

    # Multi-resolution favicon.ico (16, 32, 48)
    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    ico_imgs = [master.resize(s, Image.Resampling.LANCZOS) for s in ico_sizes]
    ico_imgs[0].save(
        os.path.join('public', 'favicon.ico'),
        format='ICO',
        sizes=ico_sizes,
        append_images=ico_imgs[1:]
    )

    # SVG icon wrapper
    with open(os.path.join('public', 'icon-512.png'), 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    svg_content = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <image href="data:image/png;base64,{b64}" width="512" height="512" />
</svg>
'''
    with open(os.path.join('public', 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg_content)

    print("Created public assets:", os.listdir('public'))

if __name__ == '__main__':
    generate_web_icons()
