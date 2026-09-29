// popup.js
const STORAGE_KEY = 'bili_saved_comments';

function updateCount() {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
        const list = result[STORAGE_KEY] ? JSON.parse(result[STORAGE_KEY]) : [];
        document.getElementById('count').textContent = list.length;
    });
}

document.getElementById('openManageBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
    window.close();
});

updateCount();