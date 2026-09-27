import os
from PIL import Image


def generate_web_icons():
    """Favicons for index.html, resized from the master app-icon.png."""
    os.makedirs('public', exist_ok=True)
    master = Image.open('app-icon.png')

    sizes = {
        'favicon-16x16.png': (16, 16),
        'favicon-32x32.png': (32, 32),
        'apple-touch-icon.png': (180, 180),
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

    print("Created public assets:", os.listdir('public'))


if __name__ == '__main__':
    generate_web_icons()
