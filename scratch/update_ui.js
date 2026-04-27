
// ============================================================
// AUTO-UPDATE UI LOGIC
// ============================================================

if (window.api && window.api.onUpdateAvailable) {
    window.api.onUpdateAvailable(() => {
        showToast(currentLang === 'ar' ? 'يوجد تحديث جديد، جاري التحميل...' : 'New update available, downloading...');
    });

    window.api.onUpdateDownloaded(() => {
        const title = currentLang === 'ar' ? 'تحديث جديد' : 'Update Ready';
        const msg = currentLang === 'ar' 
            ? 'تم تحميل التحديث بنجاح. هل تريد إغلاق البرنامج وتثبيته الآن؟' 
            : 'Update downloaded. Restart and install now?';
            
        confirmAction('update_label', '', 'info', msg).then(confirmed => {
            if (confirmed) {
                window.api.restartApp();
            }
        });
    });
}

async function handleManualUpdateCheck() {
    const btn = document.getElementById('manual-update-btn');
    if (!btn) return;

    btn.disabled = true;
    const originalText = btn.innerText;
    btn.innerText = currentLang === 'ar' ? 'جاري التحقق...' : 'Checking...';

    try {
        const result = await window.api.checkForUpdatesManual();
        if (result.success) {
            showToast(currentLang === 'ar' ? 'تم التحقق من التحديثات.' : 'Update check complete.');
        } else {
            showToast(currentLang === 'ar' ? 'فشل التحقق من التحديثات.' : 'Failed to check for updates.');
        }
    } catch (e) {
        showToast(currentLang === 'ar' ? 'حدث خطأ أثناء الاتصال بالخادم.' : 'Error connecting to server.');
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}
