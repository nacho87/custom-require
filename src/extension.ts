import * as vscode from 'vscode';
import { MyRequireDefinitionProvider, MyRequireDocumentLinkProvider } from './definitionProvider';

const JS_LANGUAGES = [
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'javascriptreact' },
  { scheme: 'file', language: 'typescriptreact' },
];

let currentRegistrations: vscode.Disposable[] = [];

function registerProviders(context: vscode.ExtensionContext) {
  for (const d of currentRegistrations) d.dispose();
  currentRegistrations = [];

  const config = vscode.workspace.getConfiguration('customRequire');
  const functionNames: string[] = config.get('functionNames', ['myRequire']);

  const defProvider = new MyRequireDefinitionProvider(functionNames);
  const linkProvider = new MyRequireDocumentLinkProvider(functionNames);

  for (const selector of JS_LANGUAGES) {
    currentRegistrations.push(
      vscode.languages.registerDefinitionProvider(selector, defProvider)
    );
    currentRegistrations.push(
      vscode.languages.registerDocumentLinkProvider(selector, linkProvider)
    );
  }

  for (const d of currentRegistrations) {
    context.subscriptions.push(d);
  }
}

export function activate(context: vscode.ExtensionContext) {
  registerProviders(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('customRequire.functionNames')) {
        registerProviders(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('customRequire.goToDefinition', () => {
      vscode.window.showInformationMessage('Custom Require: Use Ctrl+Click / Cmd+Click on paths or properties to go to their definition.');
    })
  );
}

export function deactivate() {
  for (const d of currentRegistrations) d.dispose();
}
