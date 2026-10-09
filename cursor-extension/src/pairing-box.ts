import * as vscode from "vscode";

/** Shows the pairing code with a Copy title-bar button. Resolves when the box closes (Enter or Escape). */
export function showPairingCodeBox(
  createInputBox: () => vscode.InputBox,
  copy: (text: string) => Thenable<void>,
  options: { title: string; code: string; prompt: string },
  feedbackMs = 1500
): Promise<void> {
  return new Promise((resolve) => {
    const box = createInputBox();
    let restore: NodeJS.Timeout | undefined;
    box.title = options.title;
    box.value = options.code;
    box.prompt = options.prompt;
    box.ignoreFocusOut = true;
    box.buttons = [{ iconPath: new vscode.ThemeIcon("copy"), tooltip: "Copy pairing code" }];
    box.onDidTriggerButton(async () => {
      await copy(options.code);
      box.prompt = "Copied";
      clearTimeout(restore);
      restore = setTimeout(() => { box.prompt = options.prompt; }, feedbackMs);
    });
    box.onDidAccept(() => box.hide());
    box.onDidHide(() => {
      clearTimeout(restore);
      box.dispose();
      resolve();
    });
    box.show();
  });
}
