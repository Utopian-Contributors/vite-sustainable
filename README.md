# vite-sustainable

[![npm version](https://badge.fury.io/js/vite-sustainable.svg)](https://badge.fury.io/js/vite-sustainable)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Vite plugin that generates import maps for your dependencies, enabling efficient cross-origin caching and sustainable web delivery.

## Features

🌍 **Cross-origin caching** - Dependencies are loaded from CDNs and cached across different origins  
📦 **Automatic import maps** - Generates HTML import maps with exact dependency versions  
🚀 **Zero configuration** - Works out of the box with sensible defaults  
⚡ **Build optimization** - Externalizes dependencies to reduce bundle size  
🔧 **Customizable** - Configure CDN mappings and exclusions per project

## Installation

```bash
npm install -D vite-sustainable
```

> **Note**: This plugin requires Vite 4+ as a peer dependency. If you don't have Vite installed, install it first

## Usage

### Basic Setup

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import sustainable from 'vite-sustainable'

export default defineConfig({
  plugins: [
    sustainable()
  ]
})
```

### With Options

```ts
// vite.config.ts
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
| `cdnMappingsFile` | `string` | `'./cdn-mappings.json'` | Path to CDN mappings configuration |
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

1. **Dependency Analysis** - Reads your `package.json` and lock files to determine exact versions
2. **Import Map Generation** - Creates import maps mapping package names to CDN URLs
3. **Build Externalization** - Configures Rollup to treat mapped dependencies as external
4. **HTML Injection** - Automatically injects the import map into your HTML

## Example Output

The plugin generates an import map like this in your HTML:

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.2.0",
    "react-dom": "https://esm.sh/react-dom@18.2.0"
  }
}
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