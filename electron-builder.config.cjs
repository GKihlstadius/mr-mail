// Paketering. Namnet kommer från productName i package.json, så att ett namnbyte görs på ett ställe.
const pkg = require('./package.json');

const name = pkg.productName;
const fileName = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9-]/g, '');

module.exports = {
  // Appens identitet i Windows. Ändras inte vid namnbyte, annars blir uppgraderingen en ny app.
  appId: 'io.github.gkihlstadius.mrmail',
  productName: name,
  executableName: fileName,
  copyright: pkg.author,
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/main/*.js', 'dist/preload/*.cjs', 'dist/renderer/**', 'build/icon.png', 'package.json', '!**/*.map'],
  asar: true,
  // MCP-servern körs utanför asar-arkivet så att Claude Code och Zed kan starta den med appens exe.
  extraResources: [{ from: 'dist/mcp/mr-mail-mcp.cjs', to: 'mr-mail-mcp.cjs' }],
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    artifactName: `${fileName}-Setup-\${version}.\${ext}`
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: name,
    uninstallDisplayName: name,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false
  }
};
