'use strict';
/* global browser, Backend */
// Opens the app when the toolbar button is clicked, and checks every few minutes whether anything sold.

const APP_URL = browser.runtime.getURL('app.html');
const CHECK_MINUTES = 3;

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

function scheduleChecks() {
  browser.alarms.create('check-orders', { periodInMinutes: CHECK_MINUTES });
}
browser.runtime.onInstalled.addListener(({ reason }) => {
  scheduleChecks();
  // Show the app straight after installing, so new users don't have to find the toolbar button.
  if (reason === 'install') browser.tabs.create({ url: APP_URL });
});
browser.runtime.onStartup.addListener(scheduleChecks);

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'check-orders') return;
  // An open app tab holds the list in memory, so let it do the check to avoid two writers.
  if (await tellApp({ type: 'check-orders' })) return;
  try {
    const { sold, gone } = await Backend.checkOrders(true);
    notifySales(sold, gone);
  } catch {
    // Offline or logged out: try again next time.
  }
});

function notifySales(sold, gone) {
  if (sold.length) {
    const total = sold.reduce((s, x) => s + (x.platinum ?? 0) * x.qty, 0);
    browser.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-96.png',
      title: sold.length === 1 ? `Sold: ${sold[0].qty}× ${sold[0].name}` : `${sold.length} items sold`,
      message: (sold.length === 1 ? '' : sold.map((s) => `${s.qty}× ${s.name}`).join(', ') + '. ')
        + `${total}p. Removed from your list.`,
    });
  }
  if (gone.length) {
    browser.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-96.png',
      title: gone.length === 1 ? `Listing gone: ${gone[0].name}` : `${gone.length} listings disappeared`,
      message: 'Open Tenno Trade Helper to confirm whether they sold.',
    });
  }
}

browser.notifications.onClicked.addListener(async () => {
  if (!(await tellApp({ type: 'focus' }))) await browser.tabs.create({ url: APP_URL });
});
