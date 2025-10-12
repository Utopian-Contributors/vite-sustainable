# vite-sustainable

[![npm version](https://badge.fury.io/js/vite-sustainable.svg)](https://badge.fury.io/js/vite-sustainable)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Vite post-processing tool that enhances your existing build with a sustainable alternative. It creates an additional optimized mini build with externalized dependencies loaded from CDNs using import maps, then updates your index.html to conditionally load the based on the `window.__SUSTAINABLE_BUILD__` flag. This ensures the mini build is only loaded when the sustainable browser extension is installed.


## Features

�️ **Dual Build System** - Creates both standard and optimized builds in a single step  
🌍 **Smart Loading** - Automatically selects build based on `window.__SUSTAINABLE_BUILD__` flag  
📦 **Import Maps** - Generates HTML import maps with exact dependency versions from lock files  
⚡ **CDN Externalization** - Reduces bundle size by loading dependencies from extension  
🔧 **Customizable** - Configure CDN mappings and exclusions per project  
🚀 **Post-Build Processing** - Runs after your normal Vite build completes

## Installation

```bash
npm install -D vite-sustainable
```

> **Note**: 
> - Install as a **dev dependency** (`-D` flag)
> - Requires Vite 4+ as a peer dependency
> - This is a post-processing tool that runs **after** your normal Vite build

## Usage

### As a Post-Processing Tool (Recommended)

Add to your `package.json` scripts:

```json
{
  "scripts": {
    "build": "vite build",
    "postbuild": "vite-sustainable"
  }
}
```

Then run your normal build:

```bash
npm run build
# vite-sustainable runs automatically after build completes
```

### CLI Options

```bash
# With custom options
npx vite-sustainable --outDir dist --cdnMappingsPath ./custom-mappings.json --exclude react,react-dom
```

### As a Plugin (Legacy Mode)

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import sustainable from 'vite-sustainable'

export default defineConfig({
  plugins: [
    sustainable({
      cdnMappingsFile: './custom-cdn-mappings.json',
      exclude: ['some-package'],
    })
  ]
})
```

## Configuration

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `root` | `string` | `process.cwd()` | Root directory of the project |
| `outDir` | `string` | `'dist'` | Output directory for builds |
| `cdnMappingsPath` | `string` | Built-in mappings | Path to CDN mappings configuration |
| `exclude` | `string[]` | `[]` | Packages to exclude from externalization |

### CDN Mappings

Create a `cdn-mappings.json` file to define which packages should be loaded from CDNs:

```json
{
  "react": "https://esm.sh/react@{version}",
  "react-dom": "https://esm.sh/react-dom@{version}",
  "framer-motion": "https://esm.sh/framer-motion@{version}",
  "clsx": "https://esm.sh/clsx@{version}"
}
```

The `{version}` placeholder will be replaced with the exact version from your lock file.

## How It Works

1. **Runs After Build** - Processes your existing Vite build output
2. **Dependency Analysis** - Reads lock files to find exact versions of all dependencies
3. **Mini Build Creation** - Creates optimized build with CDN-mapped dependencies in `dist/mini/`
4. **Import Map Generation** - Injects import maps for externalized dependencies
5. **Index.html Enhancement** - Updates your index.html with conditional loading:
   - When `window.__SUSTAINABLE_BUILD__` is true: loads standard build
   - Otherwise: loads mini build with CDN dependencies
6. **Original Backup** - Keeps your original index.html as `index.original.html`

## Example Output

After running the post-processor, your `dist/` directory will contain:

```
dist/
├── index.html          # Smart loader with conditional loading
├── assets/            # Standard build files
│   ├── index-xxxxx.js
│   └── index-xxxxx.css
└── mini/              # Optimized build files
    ├── index-xxxxx.js
    └── index-xxxxx.css
```

The generated `index.html` includes:

```html
<script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19.2.0",
      "react-dom": "https://esm.sh/react-dom@19.2.0"
    }
  }
</script>

<script type="module">
  await Promise.resolve(
    setTimeout(async () => {
      if (window.__SUSTAINABLE_BUILD__) {
        await import("/assets/index-xxxxx.js");
      } else {
        await import("/mini/index-xxxxx.js");
      }
    }, 10)
  );
</script>
```

## Benefits

### 👶 Reduced Bundle Size 
Dependencies are externalized and loaded from CDNs

### 🤖 Better Caching 
Dependencies cached across different applications/origins

### 🌿 Sustainable Web 
The more applications use this plugin, the more dependencies can be cached across domains and the more energy will be saved.

## Requirements

- Vite 4+ 
- Node.js 18+
- Modern browsers with [import maps support](https://caniuse.com/import-maps)

## License

MIT © [Ludwig Schubert](https://github.com/Utopian-Contributors)

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/Utopian-Contributors/vite-sustainable).