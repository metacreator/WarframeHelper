'use strict';
/* global browser */
// Opens the app when the toolbar button is clicked and passes the screenshot shortcut on to it. Nothing else:
// with no timers of its own, the browser unloads this script a few seconds after each use. Checking for sales
// and refreshing prices is done by the app page while it's open, and stops when it's closed.

const APP_URL = browser.runtime.getURL('app.html');

// Ask an open app tab to do something; resolves false when no app tab is open.
async function tellApp(message) {
  try {
    return (await browser.runtime.sendMessage(message)) === true;
  } catch {
    return false;
  }
}

browser.action.onClicked.addListener(async () => {
  if (!(await tellApp({ type: 'focus' }))) await browser.tabs.create({ url: APP_URL });
});

// The screenshot shortcut. The app tab sharing a screen takes the screenshot. If none is sharing, the app comes
// up on the quick price check, where sharing starts with a click: browsers only ask which screen after one.
async function onCommand(name) {
  if (name !== 'quick-capture') return;
  if (await tellApp({ type: 'quick-capture' })) return;
  if (await tellApp({ type: 'focus', capture: true })) return;
  const tab = await browser.tabs.create({ url: `${APP_URL}#capture` });
  await browser.windows.update(tab.windowId, { focused: true });
}
browser.commands.onCommand.addListener(onCommand);

browser.runtime.onInstalled.addListener(({ reason }) => {
  // Show the app straight after installing, so new users don't have to find the toolbar button.
  if (reason === 'install') browser.tabs.create({ url: APP_URL });
});
