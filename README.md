# Custom Require

**Go to Definition** support for custom require-like functions (e.g., `myRequire`).

VS Code's built-in "Go to Definition" (`Ctrl+Click` / `Cmd+Click`) doesn't work with custom wrapper functions that internally use `require`. This extension fills that gap.

## Features

### 1. Navigate to file from string path
```js
const Home = myRequire('./home.js');
// Ctrl+Click on './home.js' → opens home.js
```

### 2. Navigate to method/property definition
```js
const Home = myRequire('./home.js');
Home.getValue();
// Ctrl+Click on getValue → goes to getValue definition in home.js
```

### 3. Navigate to destructured export
```js
const { constante1, constante2 } = myRequire('./constantes.js');
// Ctrl+Click on constante1 → goes to where it's defined in constantes.js

console.log(constante1);
// Ctrl+Click also works on standalone references
```

## Supported export patterns in target files

- `module.exports = { key: value }`
- `module.exports = variable` (follows variable to its object literal declaration)
- `module.exports = class { method() {} }`
- `anyName.exports = value`
- `module.exports.key = value`
- `exports.key = value`
- `export function name()` / `export const name` / `export { name }`

## Configuration

In your VS Code `settings.json`:

```json
{
  "customRequire.functionNames": ["myRequire"]
}
```

Add multiple function names if needed:

```json
{
  "customRequire.functionNames": ["myRequire", "customLoad", "lazyRequire"]
}
```

## Installation

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=NachoDecima.custom-require)
2. Or download the `.vsix` from the [releases page](https://github.com/NachoDecima/custom-require/releases)

## Development

```bash
git clone https://github.com/NachoDecima/custom-require
cd custom-require
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host window.

## Requirements

- VS Code ^1.96.0
