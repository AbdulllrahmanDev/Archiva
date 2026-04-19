// Archiva | Digital Curator - Renderer Engine
const viewport = document.getElementById('app-viewport');
const insightRail = document.getElementById('insight-rail');
const railContent = document.getElementById('rail-content');
const statusToast = document.getElementById('status-toast');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const progressContainer = document.getElementById('progress-container');

let documents = [];
let pendingFiles = [];
let forceAiForNextUpload = false;
let currentView = localStorage.getItem('archiva-last-view') || 'add';
let archiveLayout = 'grid';
let isSelectionMode = false;
let activeFilters = { type: [], class: [], area: [], year: [], project: [], recency: false };

let viewsInitialized = false;
let activeDocId = null; // Track currently open doc in rail

const SVG_ICONS = {
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    archive: 'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM6.24 5h11.52l.83 1H5.41l.83-1zM5 19V8h14v11H5zm11-5.5l-4 4-4-4 1.41-1.41L11 13.67V10h2v3.67l1.59-1.59L16 13.5z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2v-2H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    grid_view: 'M4 11h5V5H4v6zm0 7h5v-6H4v6zm7 0h5v-6h-5v6zm0-13v6h5V5h-5z',
    verified: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    restart_alt: 'M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 2.97-2.17 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93 0-4.42-3.58-8-8-8zm-6 8c0-2.97 2.17-5.43 5-5.91V5.07c-3.95.49-7 3.85-7 7.93 0 4.42 3.58 8 8 8v-3c-3.31 0-6-2.69-6-6z',
    arrow_back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    arrow_outward: 'M6 6v2h8.59L5 17.59 6.41 19 16 9.41V18h2V6z',
    auto_awesome: 'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5 5.5-2.5-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z',
    cloud_upload: 'M19.35 10.04A7.49 7.49 0 0012 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 000 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z',
    arrow_right_alt: 'M16.01 11H4v2h12.01v3L20 12l-3.99-4z',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9.25 12h1.5a1.25 1.25 0 0 1 1.25 1.25a1.25 1.25 0 0 1-1.25 1.25h-1.5V17H7.75v-5h1.5z M9.25 13.25v1h1.5a.5.5 0 0 0 0-1h-1.5z',
    image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
    description: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    add_comment: 'M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm0 14H4V4h16v12zm-2-7h-5v5h-2V9H6V7h5V2h2v5h5v2z',
    edit_note: 'M3 10h11v2H3v-2zm0-2h11V6H3v2zm0 8h7v-2H3v2zm15.01-3.13l.71-.71c.39-.39 1.02-.39 1.41 0l.71.71c.39.39.39 1.02 0 1.41l-.71.71-2.12-2.12zm-.71.71L12 18.25V21h2.75l5.3-5.3-2.75-2.75z',
    edit_square: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    delete: 'M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1z',
    history: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    light_mode: 'M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.42 0s.39-1.03 0-1.42L5.99 4.58zm12.37 12.37a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.42 0s.39-1.03 0-1.42l-1.06-1.06zm1.06-12.37a.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.42s1.03.39 1.42 0l1.06-1.06c.39-.39.39-1.03 0-1.42zm-12.37 12.37a.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.42s1.03.39 1.42 0l1.06-1.06c.39-.39.39-1.03 0-1.42z',
    dark_mode: 'M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z',
    content_copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'
};

function getIcon(name, classes = "") {
    const path = SVG_ICONS[name] || SVG_ICONS['description'];
    return `<svg class="icon-svg ${classes}" viewBox="0 0 24 24"><path d="${path}"/></svg>`;
}

function copyToClipboard(text, btnElement) {
    navigator.clipboard.writeText(text).then(() => {
        const originalHTML = btnElement.innerHTML;
        
        btnElement.classList.add('text-on-surface');
        btnElement.classList.remove('text-primary/40', 'hover:text-primary');
        btnElement.innerHTML = getIcon('check', 'xs');
        
        setTimeout(() => {
            btnElement.classList.remove('text-on-surface');
            btnElement.classList.add('text-primary/40', 'hover:text-primary');
            btnElement.innerHTML = originalHTML;
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
}

const i18n = {
    en: {
        nav_add: "Add Document", nav_library: "Library", nav_ai: "AI Intelligence",
        hero_title: "Archive", hero_desc: "Upload your documents and images for deep intelligence analysis.",
        ready_analysis: "Ready for Analysis", staged_archival: "Staged for Archival",
        confirm_archival: "Confirm Archival", clear_list: "Clear List", remove: "REMOVE",
        intel_library: "Intelligence Library", archive: "Library", list: "List", grid: "Curator Grid",
        insights_dashboard: "Insights Dashboard", global_assets: "Global Assets", status: "Status", live_engine: "Live Engine",
        back_to_insights: "Back to Insights", back_to_search: "Back to Search",
        intel_summary: "Intelligence Summary", open_file: "Open File", open_folder: "Open Folder", export: "Export",
        recent_files: "Recent Files",
        last_analyzed: "Last Analyzed", action_control: "Action Control",
        search_placeholder: "Search library...", doc_class: "Document Class", region_area: "Region / Area",
        reset_all: "Reset All", done: "Done", quick_filters: "Quick Filters:", pdf_only: "PDF Only", images_only: "Images Only",
        search_analytics: "Search Analytics", keyword_density: "Keyword Density", primary_cluster: "Primary Content Cluster",
        scanning: "Scanning Library...", found_assets: "Found {count} relevant assets",
        enter_term: "Enter a term to begin", analyzed: "Analyzed", system_idle: "System Idle",
        archiving_msg: "Archiving {count} documents...", staged_msg: "Files staged. Processing in background...", exported_msg: "Exported successfully",
        archive_empty: "Archive is empty.", asset_intel: "Asset Intelligence", archived: "Archived", region: "Region",
        ai_engine: "Intelligence Engine", ai_status: "Systems Operational", ai_desc: "Archiva AI is scanning your documents for deep pattern recognition.",
        archived_title: "Archive",
        ai_welcome: "Hello. I am the Archiva Intelligence Engine. I can analyze your documents, extract insights, and answer questions. Upload an image or type a message to begin.",
        chat_placeholder: "Ask anything or attach a document...",
        new_chat: "New Chat",
        chat_reset: "Conversation reset successfully",
        ai_welcome_title: "Back at it",
        delete_confirm: "Are you sure you want to delete this document?",
        clear_confirm: "Are you sure you want to PERMANENTLY clear the entire archive?",
        delete_success: "Deleted successfully",
        archive_cleared: "Archive cleared",
        settings_title: "Settings",
        theme_label: "Appearance",
        light_theme: "Light",
        dark_theme: "Dark",
        language_label: "Language",
        delete_selected: "Delete Selected",
        cancel: "Cancel",
        confirm_title: "Confirm Action",
        confirm_btn: "Confirm",
        storage_label: "Storage Location",
        storage_change: "Change Folder",
        storage_updated: "Storage location updated",
        status_extracting: "Extracting document content...",
        status_ocr: "Running OCR scanning...",
        status_ai: "AI Engine analyzing context...",
        status_organizing: "Organizing library structure...",
        status_saving: "Finalizing archival...",
        status_idle: "System Ready",
        status_processing: "Processing: {file}",
        status_error: "Analysis failed. Using manual values.",
        status_fail: "System error during processing.",
        re_analyze_title: "AI Analysis",
        re_analyze_msg: "Do you want to re-analyze this document using Archiva Intelligence?",
        today: "Today",
        yesterday: "Yesterday",
        this_week: "Last 7 Days",
        this_month: "Earlier this Month",
        older: "Older",
        auto_analysis_label: "Auto Analysis",
        auto_analysis_desc: "Automatically analyze new files with AI",
        auto_analysis_on: "Active — monitoring new files",
        auto_analysis_off: "Inactive — files not being analyzed",
        auto_analysis_enabled_toast: "Auto-Analysis enabled. Monitoring new files.",
        auto_analysis_disabled_toast: "Auto-Analysis disabled.",
        activated_since: "Active since:",
        file_path: "File Path",
        copied: "Copied!",
        copy_path: "Copy Path"
    },
    ar: {
        nav_add: "إضافة ملف", nav_library: "الأرشيف", nav_ai: "ذكاء اصطناعي",
        hero_title: "أرشفة", hero_desc: "قم برفع مستنداتك وصورك لبدء تحليل الملفات وتنظيمها.",
        ready_analysis: "جاهز للتحليل", staged_archival: "مدرج للأرشفة",
        confirm_archival: "تأكيد الأرشفة", clear_list: "مسح القائمة", remove: "حذف",
        intel_library: "أرشيف المحتوى", archive: "الأرشيف", list: "قائمة", grid: "شبكة",
        insights_dashboard: "لوحة التفاصيل", global_assets: "إجمالي الملفات", status: "الحالة", live_engine: "محرك مباشر",
        back_to_insights: "العودة للتفاصيل", back_to_search: "العودة للبحث",
        intel_summary: "ملخص المحتوى", open_file: "فتح الملف", open_folder: "فتح المجلد", export: "تصدير",
        recent_files: "أحدث الملفات",
        last_analyzed: "آخر تحليل", action_control: "التحكم",
        search_placeholder: "ابحث في الأرشيف...", doc_class: "تصنيف المستند", region_area: "المنطقة",
        reset_all: "إعادة تعيين", done: "تم", quick_filters: "فلاتر سريعة:", pdf_only: "PDF فقط", images_only: "صور فقط",
        search_analytics: "تحليلات البحث", keyword_density: "كثافة الكلمات", primary_cluster: "المجموعة الأساسية",
        scanning: "جاري الفحص...", found_assets: "تم العثور على {count} من الأصول",
        enter_term: "أدخل كلمة للبحث", analyzed: "تم التحليل", system_idle: "نظام مستعد",
        archiving_msg: "أرشفة {count} مستندات...", staged_msg: "تم الإرسال.", exported_msg: "تم التصدير بنجاح",
        archive_empty: "الأرشيف فارغ.", asset_intel: "الملفات المؤرشفة", archived: "تمت الأرشفة", region: "المنطقة",
        ai_engine: "محرك الذكاء", ai_status: "الأنظمة تعمل", ai_desc: "يقوم نظام Archiva AI بفحص مستنداتك للتعرف على الأنماط العميقة.",
        archived_title: "مؤرشف",
        ai_welcome: "مرحباً. أنا محرك الذكاء الخاص بـ Archiva. يمكنني تحليل مستنداتك واستخراج الرؤى والإجابة على أسئلتك. أرفق صورة أو اكتب رسالة للبدء.",
        chat_placeholder: "اسأل عن أي شيء أو أرفق مستنداً...",
        new_chat: "محادثة جديدة",
        chat_reset: "تمت إعادة تعيين المحادثة",
        ai_welcome_title: "كيف يمكنني مساعدتك؟",
        delete_confirm: "هل أنت متأكد من حذف هذا المستند؟",
        clear_confirm: "هل أنت متأكد من مسح الأرشيف بالكامل نهائياً؟",
        delete_success: "تم الحذف بنجاح",
        archive_cleared: "تم مسح الأرشيف",
        settings_title: "الإعدادات",
        theme_label: "المظهر",
        light_theme: "فاتح",
        dark_theme: "داكن",
        language_label: "اللغة",
        delete_selected: "حذف المحدد",
        cancel: "إلغاء",
        confirm_title: "تأكيد الإجراء",
        confirm_btn: "تأكيد",
        storage_label: "مجلد التخزين",
        storage_change: "تغيير المجلد",
        storage_updated: "تم تحديث موقع التخزين",
        status_extracting: "جاري استخراج محتوى المستند...",
        status_ocr: "جاري إجراء الفحص الضوئي للمستند...",
        status_ai: "الذكاء الاصطناعي يقوم بتحليل السياق...",
        status_organizing: "جاري تنظيم هيكل الأرشيف...",
        status_saving: "جاري اللمسات الأخيرة للأرشفة...",
        status_idle: "تم الانتهاء من المعالجة",
        status_processing: "جاري معالجة: {file}",
        status_error: "فشل التحليل. تم استخدام بيانات افتراضية.",
        status_fail: "حدث خطأ في النظام أثناء المعالجة.",
        re_analyze_title: "تحليل الذكاء",
        re_analyze_msg: "هل تريد إعادة تحليل هذا المستند باستخدام ذكاء Archiva آلياً؟",
        today: "اليوم",
        yesterday: "أمس",
        this_week: "آخر 7 أيام",
        this_month: "في وقت سابق من هذا الشهر",
        older: "قديم جداً",
        auto_analysis_label: "التحليل التلقائي",
        auto_analysis_desc: "تحليل الملفات الجديدة تلقائياً بالذكاء الاصطناعي",
        auto_analysis_on: "نشط — يراقب الملفات الجديدة",
        auto_analysis_off: "متوقف — لن يتم تحليل الملفات",
        auto_analysis_enabled_toast: "تم تفعيل التحليل التلقائي. يراقب الملفات الجديدة الآن.",
        auto_analysis_disabled_toast: "تم إيقاف التحليل التلقائي.",
        activated_since: "نشط منذ:",
        file_path: "مسار الملف",
        copied: "تم النسخ!",
        copy_path: "نسخ المسار"
    }
};

let currentLang = localStorage.getItem('archiva-lang') || 'ar';
let currentTheme = localStorage.getItem('archiva-theme') || 'light';
let selectedDocIds = new Set();

function setTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('archiva-theme', theme);
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    window.api.setNativeTheme(theme); // Sync Electron Titlebar
    updateSettingsUI();
    updateSegmentedIndicators();
}

function updateSettingsUI() {
    // Labels
    const title = document.getElementById('settings-title');
    const themeLabel = document.getElementById('theme-label');
    const langLabel = document.getElementById('language-label');
    const lightBtn = document.getElementById('theme-light-btn');
    const darkBtn = document.getElementById('theme-dark-btn');
    const enBtn = document.getElementById('lang-en-btn');
    const arBtn = document.getElementById('lang-ar-btn');

    if (title) title.innerText = t('settings_title');
    if (themeLabel) themeLabel.innerText = t('theme_label');
    if (langLabel) langLabel.innerText = t('language_label');

    if (lightBtn) lightBtn.classList.toggle('active', currentTheme === 'light');
    if (darkBtn) darkBtn.classList.toggle('active', currentTheme === 'dark');

    if (enBtn) enBtn.classList.toggle('active', currentLang === 'en');
    if (arBtn) arBtn.classList.toggle('active', currentLang === 'ar');

    // Storage UI
    const storageLabel = document.getElementById('storage-label');
    const storageBtn = document.getElementById('change-storage-btn');

    if (storageLabel) storageLabel.innerText = t('storage_label');
    if (storageBtn) storageBtn.innerHTML = t('storage_change');

    // Auto-Analysis UI
    const autoLabel = document.getElementById('auto-analysis-label');
    const autoDesc = document.getElementById('auto-analysis-desc');
    if (autoLabel) autoLabel.innerText = t('auto_analysis_label');
    if (autoDesc) autoDesc.innerText = t('auto_analysis_desc');

    refreshStorageDisplay();
    updateSegmentedIndicators();
}

function updateSegmentedIndicators() {
    const themeIndicator = document.getElementById('theme-indicator');
    const langIndicator = document.getElementById('lang-indicator');

    if (themeIndicator) {
        const activeBtn = document.getElementById(`theme-${currentTheme}-btn`);
        if (activeBtn) {
            themeIndicator.style.left = `${activeBtn.offsetLeft}px`;
            themeIndicator.style.width = `${activeBtn.offsetWidth}px`;
        }
    }

    if (langIndicator) {
        const activeBtn = document.getElementById(`lang-${currentLang}-btn`);
        if (activeBtn) {
            langIndicator.style.left = `${activeBtn.offsetLeft}px`;
            langIndicator.style.width = `${activeBtn.offsetWidth}px`;
        }
    }
}

async function refreshStorageDisplay() {
    const display = document.getElementById('storage-path-display');
    if (display) {
        const path = await window.api.getStorageFolder();
        display.innerText = path;
    }
}

function t(key, data = {}) {
    let str = (i18n[currentLang] && i18n[currentLang][key]) || (i18n['en'] && i18n['en'][key]) || key;
    for (const k in data) str = str.replace(`{${k}}`, data[k]);
    return str;
}

const getViews = () => ({
    add: `
        <div class="flex flex-col items-center justify-center min-h-[80vh] px-6 animate-fade-in text-white/0">
            <div class="relative z-10 w-full max-w-5xl flex flex-col items-center">
                <div id="hero-header" class="text-center space-y-4 mb-12 transition-all duration-700">
                    <h1 class="font-headline text-5xl md:text-6xl font-extrabold tracking-tighter text-on-surface">${t('hero_title')}</h1>
                    <p class="text-on-surface-variant text-lg max-w-md mx-auto leading-relaxed">${t('hero_desc')}</p>
                </div>
                <div id="upload-wrapper" class="upload-btn-container relative flex flex-col items-center">
                    <button id="main-upload-btn" class="group relative flex items-center justify-center w-32 h-32 md:w-40 md:h-40 rounded-[2rem] editorial-gradient text-white shadow-2xl transition-all duration-500 active:scale-95">
                        <span id="upload-icon-container" class="group-hover:rotate-90 transition-transform">${getIcon('add', 'xl')}</span>
                    </button>
                    <div id="ready-hint" class="flex flex-col items-center gap-2 mt-8">
                        <span class="font-label text-xs uppercase tracking-[0.2em] text-on-surface-variant font-semibold">${t('ready_analysis')}</span>
                        <div class="h-1 w-12 bg-outline-variant/30 rounded-full"></div>
                    </div>
                </div>
                <div id="staging-area" class="staging-area w-full grid grid-cols-12 gap-8 items-start">
                    <div class="col-span-12 lg:col-span-8 bg-surface-container-lowest rounded-2xl editorial-shadow overflow-hidden border border-outline-variant/10 flex flex-col max-h-[500px]">
                        <div class="px-8 py-5 border-b border-outline-variant/5 bg-surface-container-low/30 flex items-center justify-between">
                            <h3 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant font-label">${t('staged_archival')}</h3>
                            <div class="flex items-center gap-3">
                                <span class="text-[9px] font-bold text-on-surface-variant/50">${currentLang === 'ar' ? 'فحص تلقائي (استثناء)' : 'Auto-Scan Override'}</span>
                                <button id="force-ai-toggle" class="w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-300 pointer-events-auto bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high" type="button">
                                    ${getIcon('auto_awesome', 'sm')}
                                </button>
                            </div>
                        </div>
                        <div id="pending-list" class="file-list-scroll flex-1 overflow-y-auto divide-y divide-outline-variant/5"></div>
                    </div>
                    <div class="col-span-12 lg:col-span-4 space-y-4">
                        <button id="confirm-upload-btn" class="w-full py-6 bg-primary text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-primary-dim transition-all" type="button">
                            ${getIcon('verified', 'sm')} ${t('confirm_archival')}
                        </button>
                        <button id="cancel-upload-btn" class="w-full py-4 bg-surface-container-low text-on-surface-variant rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-surface-container-high transition-all" type="button">
                            ${getIcon('close', 'sm')} ${t('clear_list')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `,
    archive: `
        <div class="px-8 fluid-container max-w-7xl mx-auto animate-fade-in pb-20 pt-12">
            <!-- Centered Header Section - Lowered for breathing room -->
            <div class="mb-16 flex flex-col items-center justify-center text-center">
                <h1 class="text-4xl md:text-5xl font-extrabold tracking-tight text-on-surface mb-8">${t('archived_title')}</h1>
                
                <!-- Full-Width Search Bar Container -->
                <div class="w-full relative group">
                    <div class="absolute inset-y-0 start-6 flex items-center pointer-events-none text-on-surface-variant group-focus-within:text-primary">
                        ${getIcon('search')}
                    </div>
                    <input id="global-search-input" class="w-full bg-surface-container-lowest border border-outline-variant/10 rounded-2xl py-6 ps-20 pe-28 text-xl font-headline font-semibold text-on-surface focus:ring-2 focus:ring-primary-container transition-all placeholder:text-outline/40 shadow-sm outline-none" placeholder="${t('search_placeholder')}" type="text"/>
                    <div class="absolute inset-y-0 end-6 flex items-center gap-2">
                        <button id="toggle-recency-filter" class="p-2 rounded-xl bg-surface-container-low transition-all flex items-center text-on-surface-variant pointer-events-auto" title="${t('recent_files')}">${getIcon('history', 'sm')}</button>
                        <button id="toggle-filter-menu" class="relative p-2 rounded-xl bg-surface-container-low hover:bg-primary/20 transition-all">${getIcon('tune')}<div id="filter-indicator" class="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full hidden"></div></button>
                    </div>
                    
                    <div id="filter-menu" class="filter-menu-flyout">
                        <!-- Dynamic filter sections are rendered by buildDynamicFilterMenu() -->
                        <div id="filter-dynamic-sections" class="space-y-4"></div>
                        <div class="pt-4 mt-4 border-t border-outline-variant/10 flex items-center justify-between w-full flex-shrink-0">
                            <button id="reset-filters" class="text-[10px] font-black uppercase text-error/60 transition-colors flex items-center gap-2">${getIcon('restart_alt', 'sm')}${t('reset_all')}</button>
                            <button id="apply-filters-btn" class="px-5 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-full shadow-md transition-all">${t('done')}</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-12 gap-8">
                <div class="col-span-12 lg:col-span-3 space-y-6 lg:sticky lg:top-8 lg:self-start">
                    <!-- View Switcher Tabs - Relocated to Sidebar -->
                    <div class="bg-surface-container-low p-1.5 rounded-2xl flex items-center gap-1">
                        <button id="toggle-list-view" class="view-switcher-btn flex-1 flex items-center justify-center gap-2 py-2 text-[10px] font-black uppercase tracking-widest transition-all" type="button">${getIcon('list', 'sm')}${t('list')}</button>
                        <button id="toggle-grid-view" class="view-switcher-btn flex-1 flex items-center justify-center gap-2 py-2 text-[10px] font-black uppercase tracking-widest transition-all" type="button">${getIcon('grid_view', 'sm')}${t('grid')}</button>
                    </div>

                    <div id="archive-sidebar-content" class="h-full">
                        <div id="global-insights" class="p-8 bg-surface-container-low rounded-[2rem] border border-outline-variant/5 relative group/sidebar">
                            <div class="flex items-center justify-between mb-8">
                                <h3 class="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant/50 font-label text-right rtl:text-left">${t('insights_dashboard')}</h3>
                                <button id="clear-archive-btn" class="p-2 text-on-surface-variant/20 hover:text-error transition-all opacity-0 group-hover/sidebar:opacity-100" title="Clear Archive">
                                    ${getIcon('delete', 'sm')}
                                </button>
                            </div>
                            <div id="selection-controls" class="hidden flex flex-col gap-3 mb-8 animate-fade-in border-b border-outline-variant/5 pb-8">
                                <button id="batch-delete-btn" class="w-full py-4 bg-error text-on-error text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-error/20 hover:bg-error/80 transition-all flex items-center justify-center gap-2" type="button">
                                    ${getIcon('delete', 'sm')} ${t('delete_selected')}
                                </button>
                                <button id="batch-cancel-btn" class="w-full py-3 bg-surface-container-highest text-on-surface-variant text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-surface-container-high transition-all" type="button">
                                    ${t('cancel')}
                                </button>
                            </div>
                            <div class="space-y-8">
                                <div id="results-count-container" class="space-y-1">
                                    <p class="text-sm font-medium text-on-surface-variant">${t('global_assets')}</p>
                                    <p id="total-assets" class="text-4xl font-black text-primary">0</p>
                                </div>
                            </div>
                        </div>
                        <div id="document-intelligence" class="hidden p-8 bg-surface-container-low rounded-[2rem] border border-outline-variant/5">
                            <button id="back-to-insights" class="flex items-center gap-2 text-[10px] font-black text-primary uppercase tracking-widest mb-6 transition-transform">
                                ${getIcon('arrow_back', 'sm flip-rtl')} ${t('back_to_insights')}
                            </button>
                            <div id="sidebar-doc-details" class="space-y-6"></div>
                        </div>
                    </div>
                </div>
                <div class="col-span-12 lg:col-span-9">
                    <div id="archive-render-target" class="w-full h-full min-h-[400px]"></div>
                </div>
            </div>
        </div>
    `,
    ai: `
        <div id="ai-chat-container" class="fluid-container w-full h-[calc(100vh-140px)] flex flex-col animate-fade-in relative">
            <!-- Main Scrollable Area -->
            <div id="chat-scroll-area" class="flex-1 overflow-y-auto w-full scroll-smooth px-4">
                <!-- Welcome Screen -->
                <div id="ai-welcome-screen" class="w-full h-full flex flex-col items-center justify-center p-6 text-center space-y-6">
                    <img src="../logo/Archiva.svg" class="w-16 h-16 object-contain opacity-20 mb-2">
                    <h1 class="text-4xl md:text-5xl font-bold tracking-tight text-on-surface/80 text-balance">${t('ai_welcome_title')}</h1>
                </div>

                <!-- Messages Container -->
                <div id="chat-messages" class="w-full space-y-8 flex flex-col pt-4 pb-12"></div>
            </div>

            <!-- Card-based Input Area -->
            <div class="w-full px-4 pt-4">
                <div class="max-w-3xl mx-auto bg-surface-container-low rounded-2xl border border-outline-variant/20 shadow-lg flex flex-col p-4 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
                    <div class="flex-1 flex flex-col relative w-full pt-4">
                        <div id="attachments-container" class="w-full flex items-center gap-3 overflow-x-auto pb-3 mb-2 px-1 scrollbar-hide hidden"></div>
                        <textarea id="chat-input-textarea" rows="1" class="w-full bg-transparent border-none focus:ring-0 resize-none p-0 text-md font-medium text-on-surface placeholder:text-on-surface-variant/40 max-h-64 scrollbar-hide" placeholder="${t('chat_placeholder')}"></textarea>
                    </div>

                    <div class="flex items-center justify-between mt-6">
                        <button id="chat-attach-btn" class="p-2 text-on-surface-variant hover:bg-surface-container-highest rounded-lg transition-all" title="Attach file" type="button">
                            <span class="text-primary">${getIcon('add', 'sm')}</span>
                        </button>

                        <div class="flex items-center gap-4">
                             <span class="text-[9px] font-bold uppercase tracking-[0.2em] text-on-surface-variant/40">Archiva Ai 4.0</span>
                             <button id="new-chat-btn" class="p-2 bg-primary text-white rounded-xl shadow-md hover:shadow-lg hover:scale-105 transition-all flex items-center justify-center" title="${t('new_chat')}" type="button">
                                ${getIcon('edit_square', 'sm')}
                             </button>
                             <button id="chat-send-btn" class="hidden" type="button"></button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `
});

// --- Core Logic ---

function getIconForType(type) {
    const t = (type || '').toUpperCase();
    if (t === 'PDF') return 'pdf';
    if (t === 'IMAGE') return 'image';
    return 'description';
}

function updateLayoutDirection() {
    document.documentElement.dir = 'ltr';
    document.documentElement.lang = currentLang;
    document.body.dir = (currentLang === 'ar') ? 'rtl' : 'ltr';
    document.body.classList.toggle('rtl-mode', currentLang === 'ar');

    updateSettingsUI();

    const navAdd = document.getElementById('nav-add');
    const navArchive = document.getElementById('nav-archive');
    const navAi = document.getElementById('nav-ai');
    if (navAdd) navAdd.title = t('nav_add');
    if (navArchive) navArchive.title = t('nav_library');
    if (navAi) navAi.title = t('nav_ai');

    viewsInitialized = false;
    switchView(currentView);
    moveNavIndicator(currentView);
}

function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('archiva-lang', lang);
    updateLayoutDirection();
}

function toggleSettingsModal(show) {
    const modal = document.getElementById('settings-modal');
    if (modal) {
        modal.classList.toggle('hidden', !show);
        if (show) {
            setTimeout(updateSegmentedIndicators, 10);
        }
    }
}

function confirmAction(titleKey, msgKey, type = 'error') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const title = document.getElementById('confirm-title');
        const message = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        const backdrop = document.getElementById('confirm-backdrop');
        const iconBg = document.getElementById('confirm-icon-bg');
        const iconPath = document.getElementById('confirm-icon-path');

        if (!modal || !title || !message || !okBtn || !cancelBtn) return resolve(false);

        title.innerText = t(titleKey);
        message.innerText = t(msgKey);

        okBtn.innerText = t('confirm_btn');
        cancelBtn.innerText = t('cancel');

        // Apply Theme
        if (type === 'ai') {
            if (iconBg) iconBg.className = "w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center transition-all duration-500";
            if (okBtn) okBtn.className = "flex-1 py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-lg shadow-primary/20 hover:bg-primary/80 transition-all active:scale-95";
            if (iconPath) iconPath.setAttribute('d', SVG_ICONS['auto_awesome']);
        } else {
            // Default Error Theme
            if (iconBg) iconBg.className = "w-16 h-16 bg-error/10 text-error rounded-full flex items-center justify-center transition-all duration-500";
            if (okBtn) okBtn.className = "flex-1 py-4 bg-error text-white text-[10px] font-black uppercase tracking-widest rounded-2xl shadow-lg shadow-error/20 hover:bg-error/80 transition-all active:scale-95";
            if (iconPath) iconPath.setAttribute('d', 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z');
        }

        modal.classList.remove('hidden');

        const cleanup = (val) => {
            modal.classList.add('hidden');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            backdrop.onclick = null;
            resolve(val);
        };

        okBtn.onclick = () => cleanup(true);
        cancelBtn.onclick = () => cleanup(false);
        backdrop.onclick = () => cleanup(false);
    });
}

function showToast(msgKey, data = {}, duration = 3000) {
    if (!statusText || !statusToast) return;
    statusText.innerText = t(msgKey, data);
    statusToast.style.opacity = '1';
    statusToast.style.pointerEvents = 'auto';
    if (duration > 0) {
        setTimeout(() => {
            statusToast.style.opacity = '0';
            statusToast.style.pointerEvents = 'none';
        }, duration);
    }
}

function moveNavIndicator(viewName) {
    const btn = document.getElementById(`nav-${viewName}`);
    const indicator = document.getElementById('nav-indicator');
    if (btn && indicator) {
        indicator.style.width = `${btn.offsetWidth}px`;
        indicator.style.left = `${btn.offsetLeft}px`;
    }
}
// --- Chat Logic ---
let chatHistory = [];
let pendingAttachments = [];

function setupChatUI() {
    const chatMessages = document.getElementById('chat-messages');
    const welcomeScreen = document.getElementById('ai-welcome-screen');

    // Clear welcome message if history exists
    chatMessages.innerHTML = '';
    if (chatHistory.length > 0) {
        welcomeScreen.classList.add('hidden');
        chatMessages.classList.remove('hidden');
    } else {
        welcomeScreen.classList.remove('hidden');
        chatMessages.classList.add('hidden');
    }

    // Render existing history
    chatHistory.forEach(msg => appendMessageToUI(msg.role, msg.content, msg.attachments));

    const input = document.getElementById('chat-input-textarea');
    const sendBtn = document.getElementById('chat-send-btn');
    const visibleSendBtn = document.getElementById('chat-send-btn-visible');
    const attachBtn = document.getElementById('chat-attach-btn');
    const removeAttachBtn = document.getElementById('chat-remove-attachment');
    const newChatBtn = document.getElementById('new-chat-btn');

    if (newChatBtn) {
        newChatBtn.onclick = () => {
            chatHistory = [];
            pendingAttachments = [];
            chatMessages.innerHTML = '';
            welcomeScreen.classList.remove('hidden');
            input.value = '';
            input.style.height = 'auto';
            renderAttachments();
        };
    }

    // Auto-resize textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 128) + 'px'; // Max 32rem
    });

    const triggerSend = async () => {
        const text = input.value.trim();
        if (!text && pendingAttachments.length === 0) return;

        input.value = '';
        input.style.height = 'auto';

        const userMsg = {
            role: 'user',
            content: text,
            attachments: [...pendingAttachments]
        };

        chatHistory.push(userMsg);
        appendMessageToUI('user', text, userMsg.attachments);
        scrollToChatBottom();

        // Clear attachment UI
        pendingAttachments = [];
        renderAttachments();

        // Add loading state
        const loadingId = 'loading-' + Date.now();
        appendMessageToUI('assistant', '<div class="flex items-center gap-1.5 h-4"><div class="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce"></div><div class="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce" style="animation-delay: 0.1s"></div><div class="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce" style="animation-delay: 0.2s"></div></div>', null, loadingId);
        scrollToChatBottom();

        // Send to backend
        try {
            const response = await window.api.sendChat(chatHistory);
            const loadingEl = document.getElementById(loadingId);
            if (loadingEl) loadingEl.remove();

            if (response.error) {
                appendMessageToUI('assistant', `<span class="text-error">Error: ${response.error}</span>`);
            } else {
                chatHistory.push({ role: 'assistant', content: response.text });
                appendMessageToUI('assistant', response.text);
            }
        } catch (err) {
            const loadingEl = document.getElementById(loadingId);
            if (loadingEl) loadingEl.remove();
            appendMessageToUI('assistant', `<span class="text-error">Connection Failed.</span>`);
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            triggerSend();
        }
    });

    sendBtn.addEventListener('click', triggerSend);

    attachBtn.addEventListener('click', async () => {
        const files = await window.api.selectFiles();
        if (files && files.length > 0) {
            // Push maximum 5 files total at a time
            const total = pendingAttachments.length + files.length;
            if (total > 5) {
                showToast('Maximum 5 attachments allowed.');
                const diff = 5 - pendingAttachments.length;
                pendingAttachments.push(...files.slice(0, diff));
            } else {
                pendingAttachments.push(...files);
            }
            renderAttachments();
            input.focus();
        }
    });

}

function renderAttachments() {
    const container = document.getElementById('attachments-container');
    if (!container) return;

    if (pendingAttachments.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    container.innerHTML = pendingAttachments.map((file, index) => {
        const ext = file.name.split('.').pop().toLowerCase();
        const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
        const iconDiv = isImage
            ? `<img src="file://${file.path.replace(/\\\\/g, '/')}" class="w-full h-full object-cover">`
            : `<div class="text-error bg-error/10 w-full h-full flex items-center justify-center">${getIcon('picture_as_pdf', 'sm')}</div>`;

        return `
            <div class="bg-surface border border-outline-variant/20 shadow-md p-1.5 rounded-xl flex items-center gap-3 shrink-0 max-w-[200px] animate-fade-in group hover:border-error/30 transition-all">
                <div class="w-8 h-8 rounded shrink-0 bg-surface-container-highest flex items-center justify-center overflow-hidden">
                    ${iconDiv}
                </div>
                <div class="flex flex-col flex-1 min-w-0">
                    <span class="text-[10px] truncate font-bold text-on-surface" dir="auto">${file.name}</span>
                    <span class="text-[8px] font-bold text-on-surface-variant uppercase">${ext}</span>
                </div>
                <button class="remove-attachment-btn text-on-surface-variant group-hover:text-error hover:bg-error/10 rounded-full p-1 transition-all" data-index="${index}">
                    ${getIcon('close', 'sm')}
                </button>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.remove-attachment-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.getAttribute('data-index'));
            pendingAttachments.splice(idx, 1);
            renderAttachments();
        });
    });
}

// --- AI Vision Visualization ---

function isDetectionJSON(text) {
    try {
        const data = JSON.parse(text);
        if (Array.isArray(data) && data.length > 0 && data[0].box_2d) return true;
    } catch (e) { }
    return false;
}

function renderVisionPanel(text) {
    let detections = [];
    try { detections = JSON.parse(text); } catch (e) { return text; }

    // Find last image in history
    let lastImagePath = null;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        const msg = chatHistory[i];
        if (msg.attachments) {
            const img = msg.attachments.find(a => !a.path.toLowerCase().endsWith('.pdf'));
            if (img) {
                lastImagePath = img.path;
                break;
            }
        }
    }

    if (!lastImagePath) return `<pre class="bg-surface-container-highest p-4 rounded-xl text-xs overflow-x-auto">${text}</pre>`;

    const boxesHtml = detections.map((det, idx) => {
        // Gemini coords: [ymin, xmin, ymax, xmax] normalized to 1000
        const [ymin, xmin, ymax, xmax] = det.box_2d;
        const width = (xmax - xmin) / 10;
        const height = (ymax - ymin) / 10;
        const left = xmin / 10;
        const top = ymin / 10;

        const label = det.label || `Object ${idx + 1}`;
        const labelWidth = (label.length * 7) + 12;

        return `
            <rect class="detection-box" x="${left}%" y="${top}%" width="${width}%" height="${height}%">
                <title>${label}</title>
            </rect>
            <g class="detection-label-group">
                <rect class="detection-label-bg" x="${left}%" y="${Math.max(0, top - 3)}%" width="${labelWidth}px" height="18px"></rect>
                <text class="detection-label-text" x="${left + 0.5}%" y="${Math.max(2, top - 1)}%" dominant-baseline="middle">${label}</text>
            </g>
        `;
    }).join('');

    const summaryList = detections.map(d => `<li>${d.label}</li>`).slice(0, 5).join(', ');
    const moreCount = detections.length > 5 ? ` and ${detections.length - 5} more` : '';

    return `
        <div class="vision-panel">
            <div class="detection-container">
                <img src="file://${lastImagePath.replace(/\\/g, '/')}" alt="Base Image">
                <svg class="detection-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                    ${boxesHtml}
                </svg>
            </div>
            <div class="vision-summary">
                <h4>Detected Elements</h4>
                <p>Identified ${detections.length} key components in the asset: ${summaryList}${moreCount}.</p>
            </div>
        </div>
    `;
}

function appendMessageToUI(role, text, attachments = null, id = null) {
    const chatMessages = document.getElementById('chat-messages');
    const welcomeScreen = document.getElementById('ai-welcome-screen');
    if (!chatMessages) return;

    // Hide welcome and reveal messages on first message
    if (welcomeScreen && !welcomeScreen.classList.contains('hidden')) {
        welcomeScreen.classList.add('hidden');
    }
    chatMessages.classList.remove('hidden');

    const isUser = role === 'user';

    let contentHtml = '';
    if (attachments && attachments.length > 0) {
        contentHtml += `<div class="flex flex-wrap gap-3 mb-3">`;
        attachments.forEach(file => {
            const isPdf = file.path.toLowerCase().endsWith('.pdf');
            const fileName = file.name || file.path.split(/[/\\]/).pop();

            if (isPdf) {
                contentHtml += `<div class="flex items-center gap-3 p-3 bg-surface-container-highest rounded-xl border border-outline-variant/10 shadow-sm max-w-[250px]"><div class="w-10 h-10 bg-error/10 text-error flex items-center justify-center rounded-lg flex-shrink-0">${getIcon('picture_as_pdf', 'sm')}</div><span class="text-xs font-semibold truncate flex-1 text-on-surface" dir="auto">${fileName}</span></div>`;
            } else {
                contentHtml += `<img src="file://${file.path.replace(/\\\\/g, '/')}" class="h-24 w-auto rounded-xl border border-outline-variant/10 shadow-sm object-cover">`;
            }
        });
        contentHtml += `</div>`;
    }

    if (text) {
        if (isUser) {
            contentHtml += `<div>${text.replace(/\\n/g, '<br>')}</div>`;
        } else {
            if (isDetectionJSON(text)) {
                contentHtml += renderVisionPanel(text);
            } else {
                const mdHtml = window.marked ? window.marked.parse(text) : text;
                contentHtml += `<div class="chat-markdown">${mdHtml}</div>`;
            }
        }
    }

    const isRtl = currentLang === 'ar';
    let wrapperClasses = '';

    if (isUser) {
        wrapperClasses = isRtl ? 'mr-auto items-start' : 'ml-auto items-end';
    } else {
        wrapperClasses = isRtl ? 'ml-auto items-end text-right' : 'mr-auto items-start text-left';
    }

    const isLoading = id && id.startsWith('loading-');

    const html = `
        <div class="max-w-3xl mx-auto w-full mb-6 flex flex-col" ${id ? `id="${id}"` : ''}>
            <div class="w-fit min-w-0 flex flex-col ${wrapperClasses} max-w-[85%]">
                ${!isUser ? `
                <div class="flex items-center gap-2.5 mb-2 group ${isRtl ? 'flex-row-reverse' : 'flex-row'}">
                    <div class="relative w-6 h-6 rounded-full bg-surface-container flex items-center justify-center flex-shrink-0 border border-outline-variant/10 overflow-hidden shadow-sm">
                        ${isLoading ? `<div class="absolute inset-0 rounded-full border-[1.5px] border-primary/20 border-t-primary animate-spin"></div>` : ''}
                        <img src="../logo/Archiva.svg" class="w-4 h-4 object-contain" alt="Archiva AI">
                    </div>
                    <span class="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant/50">Archiva AI</span>
                </div>
                <div class="text-on-surface px-0 py-0 text-[1.05rem] leading-relaxed break-words font-medium">
                    ${contentHtml}
                </div>
                ` : `
                <div class="bg-primary/5 text-on-surface rounded-3xl ${isRtl ? 'rounded-bl-sm' : 'rounded-br-sm'} px-6 py-4 text-[1rem] leading-relaxed border border-primary/10 break-words font-medium shadow-sm">
                    ${contentHtml}
                </div>
                `}
            </div>
        </div>
    `;

    chatMessages.insertAdjacentHTML('beforeend', html);
}

function scrollToChatBottom() {
    const scrollArea = document.getElementById('chat-scroll-area');
    if (scrollArea) {
        scrollArea.scrollTop = scrollArea.scrollHeight;
    }
}

function switchView(viewName) {
    if (!viewport) return;
    
    // Persist view state
    localStorage.setItem('archiva-last-view', viewName);
    
    const isNewView = (currentView !== viewName);
    currentView = viewName;

    const isFirstInit = !viewsInitialized;
    if (isFirstInit) {
        const views = getViews();
        document.getElementById('app-viewport').innerHTML = `
            <div id="view-add" class="view-container hidden">${views.add}</div>
            <div id="view-archive" class="view-container hidden">${views.archive}</div>
            <div id="view-ai" class="view-container hidden">${views.ai}</div>
            <div id="view-settings" class="view-container hidden">${views.settings}</div>
        `;
        viewsInitialized = true;

        setupChatUI();

        const upBtn = document.getElementById('main-upload-btn');
        if (upBtn) upBtn.onclick = handleFileSelection;

        const gridBtn = document.getElementById('toggle-grid-view');
        const listBtn = document.getElementById('toggle-list-view');
        if (gridBtn && listBtn) {
            gridBtn.onclick = () => { archiveLayout = 'grid'; renderArchiveView(); };
            listBtn.onclick = () => { archiveLayout = 'list'; renderArchiveView(); };
        }

        const backBtn = document.getElementById('back-to-insights');
        const insights = document.getElementById('global-insights');
        const intel = document.getElementById('document-intelligence');
        if (backBtn && insights && intel) {
            backBtn.onclick = () => {
                insights.classList.remove('hidden');
                intel.classList.add('hidden');
            }
        };

        const clearBtn = document.getElementById('clear-archive-btn');
        const batchDeleteBtn = document.getElementById('batch-delete-btn');
        const batchCancelBtn = document.getElementById('batch-cancel-btn');

        if (clearBtn) clearBtn.onclick = handleClearArchive;
        // Import folder (memory) button
        const importBtn = document.getElementById('import-folder-btn');
        if (importBtn) importBtn.onclick = handleImportFolder;
        if (batchDeleteBtn) batchDeleteBtn.onclick = handleBatchDelete;
        if (batchCancelBtn) batchCancelBtn.onclick = exitSelectionMode;

        const input = document.getElementById('global-search-input');
        const filterMenu = document.getElementById('filter-menu');
        const filterToggle = document.getElementById('toggle-filter-menu');

        if (input) {
            input.oninput = (e) => renderArchiveView(e.target.value);
        }
        const recencyBtn = document.getElementById('toggle-recency-filter');
        if (recencyBtn) {
            recencyBtn.onclick = (e) => {
                e.stopPropagation();
                activeFilters.recency = !activeFilters.recency;
                recencyBtn.classList.toggle('bg-primary', activeFilters.recency);
                recencyBtn.classList.toggle('text-white', activeFilters.recency);
                recencyBtn.classList.toggle('bg-surface-container-low', !activeFilters.recency);
                recencyBtn.classList.toggle('text-on-surface-variant', !activeFilters.recency);
                recencyBtn.classList.toggle('shadow-md', activeFilters.recency);
                // re-render list with recency sorting logic applied
                const currentInput = document.getElementById('global-search-input');
                renderArchiveView(currentInput?.value || '');
            };
        }

        if (filterToggle && filterMenu) {
            filterToggle.onclick = (e) => {
                e.stopPropagation();
                filterMenu.classList.toggle('active');
            };
        }

        document.querySelectorAll('.filter-option').forEach(opt => {
            const cat = opt.getAttribute('data-cat');
            const val = opt.getAttribute('data-val');
            if (activeFilters[cat].includes(val)) opt.classList.add('selected');
            opt.onclick = () => {
                opt.classList.toggle('selected');
                if (opt.classList.contains('selected')) {
                    if (!activeFilters[cat].includes(val)) activeFilters[cat].push(val);
                } else {
                    activeFilters[cat] = activeFilters[cat].filter(v => v !== val);
                }
                updateFilterIndicator();
                const currentInput = document.getElementById('global-search-input');
                renderArchiveView(currentInput?.value || '');
            };
        });

        const resetBtn = document.getElementById('reset-filters');
        if (resetBtn) {
            resetBtn.onclick = () => {
                resetFilters();
                const currentInput = document.getElementById('global-search-input');
                renderArchiveView(currentInput?.value || '');
            };
        }

        const applyBtn = document.getElementById('apply-filters-btn');
        if (applyBtn && filterMenu) {
            applyBtn.onclick = () => filterMenu.classList.remove('active');
        }

        const devLink = document.getElementById('dev-github-link');
        if (devLink) {
            devLink.onclick = (e) => {
                e.preventDefault();
                window.api.openPath('https://github.com/AbdulllrahmanDev');
            };
        }
    }

    const viewAdd = document.getElementById('view-add');
    const viewArchive = document.getElementById('view-archive');
    const viewAi = document.getElementById('view-ai');
    const viewSettings = document.getElementById('view-settings');

    const viewElements = {
        'add': viewAdd,
        'archive': viewArchive,
        'ai': viewAi,
        'settings': viewSettings
    };

    // Hide all, then show active
    Object.keys(viewElements).forEach(view => {
        const el = viewElements[view];
        if (el) {
            if (view === viewName) {
                el.classList.remove('hidden');
                // Only trigger fade-in animation if it's actually a DIFFERENT view
                if (isNewView || isFirstInit) {
                    el.classList.remove('animate-fade-in');
                    void el.offsetWidth; // Trigger reflow
                    el.classList.add('animate-fade-in');
                }
            } else {
                el.classList.add('hidden');
            }
        }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    const navBtn = document.getElementById(`nav-${viewName}`);
    if (navBtn) navBtn.classList.add('active');

    moveNavIndicator(viewName);

    if (viewName === 'archive') {
        window.api.getDocuments().then(docs => {
            documents = docs || [];
            const currentInput = document.getElementById('global-search-input');
            renderArchiveView(currentInput ? currentInput.value : '');
            buildDynamicFilterMenu(); // Populate filters from real data
        });

        const insights = document.getElementById('global-insights');
        const intel = document.getElementById('document-intelligence');
        if (insights && intel && !isFirstInit) {
            insights.classList.remove('hidden');
            intel.classList.add('hidden');
        }

        const input = document.getElementById('global-search-input');
    }
}

function resetFilters() {
    activeFilters = { type: [], class: [], area: [], year: [], project: [], recency: false };
    document.querySelectorAll('.filter-option').forEach(o => o.classList.remove('selected'));
    updateFilterIndicator();
}

function updateFilterIndicator() {
    const dot = document.getElementById('filter-indicator');
    if (dot) {
        const isFiltered = activeFilters.class.length > 0 || activeFilters.year.length > 0
            || activeFilters.project.length > 0 || activeFilters.type.length > 0;
        dot.style.display = isFiltered ? 'block' : 'none';
    }
}

// ============================================================
// SMART SEARCH ENGINE
// ============================================================

/**
 * Weighted fuzzy search. Returns a relevance score > 0 if the doc matches,
 * 0 if it doesn't. Higher = more relevant.
 */
function fuzzyScore(doc, term) {
    if (!term || !term.trim()) return 1; // No query → everything matches

    const tokens = term.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);

    const fields = [
        { val: doc.subject || '', weight: 12 },
        { val: doc.title || '', weight: 10 },
        { val: doc.version_no || '', weight: 8 },  // رقم الصادر/الوارد
        { val: doc.project || '', weight: 6 },
        { val: doc.doc_date || '', weight: 5 },
        { val: doc.summary || '', weight: 3 },
        { val: doc.file || '', weight: 2 },
        { val: doc.content || '', weight: 1 },
    ];

    let totalScore = 0;

    for (const token of tokens) {
        let tokenScore = 0;
        for (const field of fields) {
            const haystack = field.val.toLowerCase();
            if (haystack.includes(token)) {
                // Exact-word bonus: double score when it's a standalone word
                const wordBoundary = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
                tokenScore += wordBoundary.test(haystack) ? field.weight * 2 : field.weight;
            }
        }
        if (tokenScore === 0) return 0; // All tokens must match
        totalScore += tokenScore;
    }

    return totalScore;
}

// ============================================================
// DYNAMIC FILTER MENU BUILDER
// ============================================================

/**
 * Reads the current `documents` array and rebuilds the filter panel
 * with real data: unique years, projects, and file types.
 */
function buildDynamicFilterMenu() {
    const container = document.getElementById('filter-dynamic-sections');
    if (!container) return;

    const years = new Set();
    const projects = new Set();
    const types = new Set();
    const classes = new Set();

    documents.forEach(doc => {
        if (doc.doc_date) {
            const y = String(doc.doc_date).split('-')[0];
            if (y && y.length >= 4) years.add(y);
        }
        if (doc.project && !['\u063a\u064a\u0631 \u0645\u062d\u062f\u062f', '\u063a\u064a\u0631_\u0645\u062d\u062f\u062f', 'general', '\u0639\u0627\u0645', ''].includes((doc.project || '').toLowerCase().trim())) {
            projects.add(doc.project);
        }
        if (doc.type) types.add(doc.type);
        if (doc.class && !['\u0623\u062e\u0631\u0649', '\u0648\u062b\u064a\u0642\u0629', ''].includes((doc.class || '').trim())) {
            classes.add(doc.class);
        }
    });

    // Build a horizontal-scroll chip row section
    const makeSection = (titleLabel, cat, values, labelFn = v => v) => {
        if (values.length === 0) return '';
        return `
            <div class="filter-section-group" data-cat="${cat}">
                <div class="flex items-center justify-between mb-3 border-b border-outline-variant/10 pb-2 flex-row-reverse">
                    <span class="text-[8px] font-black text-primary/30 uppercase tracking-tighter">${values.length} ${currentLang === 'ar' ? 'عناصر' : 'Items'}</span>
                    <h4 class="filter-section-title !mb-0 transition-colors">${titleLabel}</h4>
                </div>
                <div class="filter-chips-row">
                    ${values.map(v => {
            const isActive = (activeFilters[cat] || []).includes(v);
            return `<div class="filter-option ${isActive ? 'selected' : ''}" data-cat="${cat}" data-val="${v}">${labelFn(v)}</div>`;
        }).join('')}
                </div>
            </div>`;
    };

    const searchPlaceholder = currentLang === 'ar' ? 'ابحث في الفلاتر...' : 'Search filters...';

    container.innerHTML = `
        <div class="mb-3">
            <input id="filter-inner-search" type="text"
                placeholder="${searchPlaceholder}"
                class="filter-search-input" autocomplete="off">
        </div>
        ${[
            makeSection(currentLang === 'ar' ? 'تصنيف الوثيقة' : 'Class', 'class', [...classes]),
            makeSection(currentLang === 'ar' ? 'السنة' : 'Year', 'year', [...years].sort().reverse()),
            makeSection(currentLang === 'ar' ? 'المشروع' : 'Project', 'project', [...projects]),
            makeSection(currentLang === 'ar' ? 'الصيغة' : 'Format', 'type', [...types], v => v),
        ].join('')}
    `;

    // ── Inner search: live-filter chips across all sections ──
    const searchEl = container.querySelector('#filter-inner-search');
    if (searchEl) {
        searchEl.addEventListener('input', () => {
            const q = searchEl.value.toLowerCase().trim();
            container.querySelectorAll('.filter-section-group').forEach(section => {
                let anyVisible = false;
                section.querySelectorAll('.filter-option').forEach(chip => {
                    const match = q === '' || chip.textContent.toLowerCase().includes(q);
                    chip.style.display = match ? '' : 'none';
                    if (match) anyVisible = true;
                });
                section.style.display = anyVisible ? '' : 'none';
            });
        });
    }

    // ── Re-attach toggle listeners on chips ──
    container.querySelectorAll('.filter-option').forEach(opt => {
        const cat = opt.getAttribute('data-cat');
        const val = opt.getAttribute('data-val');
        if (!activeFilters[cat]) activeFilters[cat] = [];
        opt.onclick = () => {
            opt.classList.toggle('selected');
            const arr = activeFilters[cat];
            if (opt.classList.contains('selected')) {
                if (!arr.includes(val)) arr.push(val);
            } else {
                activeFilters[cat] = arr.filter(v => v !== val);
            }
            updateFilterIndicator();
            renderArchiveView(document.getElementById('global-search-input')?.value || '');
        };
    });
}

function getTimeRangeGroup(dateStr) {
    if (!dateStr) return 'older';
    const docDate = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    if (docDate >= today) return 'today';
    if (docDate >= yesterday) return 'yesterday';
    if (docDate >= sevenDaysAgo) return 'this_week';
    if (docDate >= thirtyDaysAgo) return 'this_month';
    return 'older';
}

function groupDocumentsByDate(docs) {
    const groups = {
        today: [],
        yesterday: [],
        this_week: [],
        this_month: [],
        older: []
    };
    docs.forEach(doc => {
        const group = getTimeRangeGroup(doc.date_added);
        groups[group].push(doc);
    });
    return Object.keys(groups)
        .filter(key => groups[key].length > 0)
        .map(key => ({ key, label: t(key), docs: groups[key] }));
}

function renderArchiveView(term = '') {
    const target = document.getElementById('archive-render-target');
    const totalAssetsEl = document.getElementById('total-assets');
    if (!target) return;

    // --- Fuzzy search + scoring ---
    let scored = documents.map(doc => ({ doc, score: fuzzyScore(doc, term) }));

    // Sort by relevance when searching, preserve date order otherwise
    if (term && term.trim()) {
        scored.sort((a, b) => b.score - a.score);
    }
    let filtered = scored.filter(({ score }) => score > 0).map(({ doc }) => doc);

    // --- Smart dynamic filters ---
    if (activeFilters.year && activeFilters.year.length > 0)
        filtered = filtered.filter(d => activeFilters.year.includes(String(d.doc_date || '').split('-')[0]));
    if (activeFilters.project && activeFilters.project.length > 0)
        filtered = filtered.filter(d => activeFilters.project.includes(d.project));
    if (activeFilters.type && activeFilters.type.length > 0)
        filtered = filtered.filter(d => activeFilters.type.includes(d.type));

    // Sort and Group by date_added when recency is active
    let groupedData = null;
    if (activeFilters.recency) {
        filtered.sort((a, b) => new Date(b.date_added) - new Date(a.date_added));
        groupedData = groupDocumentsByDate(filtered);
    }

    if (activeFilters.class && activeFilters.class.length > 0)
        filtered = filtered.filter(d => activeFilters.class.includes(d.class));

    if (totalAssetsEl) totalAssetsEl.innerText = filtered.length;

    if (!isSelectionMode) selectedDocIds.clear();

    if (archiveLayout === 'grid') {
        renderArchiveGrid(groupedData || filtered, target, !!groupedData);
    } else {
        renderArchiveList(groupedData || filtered, target, !!groupedData);
    }

    const gridToggle = document.getElementById('toggle-grid-view');
    const listToggle = document.getElementById('toggle-list-view');
    if (gridToggle) gridToggle.classList.toggle('active', archiveLayout === 'grid');
    if (listToggle) listToggle.classList.toggle('active', archiveLayout === 'list');

    const controls = document.getElementById('selection-controls');
    const clearBtn = document.getElementById('clear-archive-btn');
    if (controls) controls.classList.toggle('hidden', !isSelectionMode);
    if (clearBtn) {
        clearBtn.classList.toggle('text-error', isSelectionMode);
        clearBtn.classList.toggle('opacity-100', isSelectionMode);
    }
}

function renderArchiveGrid(data, container, isGrouped = false) {
    if (isGrouped ? data.length === 0 : data.length === 0) {
        container.innerHTML = `<div class="p-12 text-center text-on-surface-variant opacity-50">${t('archive_empty')}</div>`;
        return;
    }

    let html = '<div class="curator-grid">';

    if (isGrouped) {
        data.forEach(group => {
            html += `
                <div class="col-span-full py-4 flex items-center gap-3">
                    <h3 class="timeline-group-title text-xs font-black uppercase tracking-widest text-on-surface/60">${group.label}</h3>
                    <div class="h-[1px] flex-1 bg-outline-variant/10"></div>
                    <span class="text-[10px] font-bold text-primary/40 bg-primary/5 px-2 py-0.5 rounded-full">${group.docs.length}</span>
                </div>
            `;
            html += group.docs.map(doc => renderGridCard(doc)).join('');
        });
    } else {
        html += data.map(doc => renderGridCard(doc)).join('');
    }

    html += '</div>';
    container.innerHTML = html;

    // Attach deletion listeners
    container.querySelectorAll('.delete-doc-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-id');
            const path = btn.getAttribute('data-path');
            handleDeleteDocument(id, path);
        };
    });
}

function renderGridCard(doc) {
    const isSelected = selectedDocIds.has(doc.id.toString());
    return `
        <div class="curator-card group cursor-pointer relative ${isSelected ? 'ring-2 ring-primary' : ''}" onclick="handleDocClick(event, '${doc.id}')" data-doc-id="${doc.id}">
            ${isSelectionMode ? `
                <div class="absolute top-4 right-4 z-20">
                    <input type="checkbox" class="w-5 h-5 rounded border-outline-variant/30 text-primary focus:ring-primary pointer-events-none" ${isSelected ? 'checked' : ''}>
                </div>
            ` : ''}
            <div class="card-preview">
                <div class="card-preview-gradient"></div>

                <div class="text-[1.75rem] font-black text-on-surface-variant/10 tracking-tighter uppercase select-none">${doc.type}</div>
                    <!-- Format tag hidden as the central text now represents it -->
                ${!isSelectionMode ? `
                    <div class="absolute top-4 right-4 z-20">
                        <button class="delete-doc-btn p-1.5 text-on-surface-variant/60 hover:text-error bg-surface-container-highest/80 backdrop-blur-md rounded-full border border-outline-variant/20 shadow-sm transition-all opacity-0 group-hover:opacity-100" data-id="${doc.id}" data-path="${doc.file_path.replace(/\\/g, '\\\\')}" type="button">
                            ${getIcon('delete', 'sm')}
                        </button>
                    </div>
                ` : ''}
            </div>
            <div class="card-content">
                <div class="flex-1 min-w-0 mb-3">
                    <h4 class="font-bold text-on-surface line-clamp-2 break-anywhere mb-1 leading-snug">${doc.title}</h4>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        ${doc.project ? `<span class="text-[9px] font-black text-primary uppercase tracking-tighter">${doc.project}</span>` : ''}
                        ${doc.subject ? `<span class="text-[9px] font-black text-on-surface-variant/40 uppercase tracking-tighter">• ${doc.subject}</span>` : ''}
                    </div>
                </div>
                <div class="pt-3 border-t border-outline-variant/5 flex items-center justify-between">
                    <div class="flex flex-col gap-0.5">
                        <span class="text-[8px] font-black text-on-surface-variant/30 uppercase tracking-widest">${doc.doc_date || doc.date_added}</span>
                        <span class="text-[8px] font-black text-primary/40 uppercase tracking-widest">إصدار ${doc.version_no || '1.0'}</span>
                    </div>
                    <div class="text-primary flip-rtl">${getIcon('arrow_outward', 'sm')}</div>
                </div>
            </div>
        </div>
    `;
}

function renderArchiveList(data, container, isGrouped = false) {
    if (isGrouped ? data.length === 0 : data.length === 0) {
        container.innerHTML = `<div class="p-12 text-center text-on-surface-variant opacity-50">${t('archive_empty')}</div>`;
        return;
    }

    let html = `<div class="bg-surface-container-lowest rounded-3xl editorial-shadow overflow-hidden border border-outline-variant/10 divide-y divide-outline-variant/5">`;

    if (!isGrouped) {
        html += `
            <div class="grid grid-cols-12 px-8 py-5 text-[0.65rem] font-black uppercase tracking-[0.2em] text-on-surface-variant/40 font-label">
                <div class="col-span-8 flex items-center gap-4">
                    ${isSelectionMode ? '<div class="w-5"></div>' : ''}
                    ${t('asset_intel')}
                </div>
                <div class="col-span-4 text-right rtl:text-left">${t('archived')}</div>
            </div>
        `;
        html += data.map(doc => renderListRow(doc)).join('');
    } else {
        data.forEach(group => {
            html += `
                <div class="px-8 py-4 bg-surface-container-low/30 flex items-center justify-between border-b border-outline-variant/5">
                    <h3 class="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface/40 font-label">${group.label}</h3>
                    <span class="text-[10px] font-bold text-primary/40 bg-primary/10 px-2 py-0.5 rounded-full">${group.docs.length}</span>
                </div>
            `;
            html += group.docs.map(doc => renderListRow(doc)).join('');
        });
    }

    html += '</div>';
    container.innerHTML = html;

    // Attach deletion listeners
    container.querySelectorAll('.delete-doc-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-id');
            const path = btn.getAttribute('data-path');
            handleDeleteDocument(id, path);
        };
    });
}

function renderListRow(doc) {
    const isSelected = selectedDocIds.has(doc.id.toString());
    return `
        <div class="grid grid-cols-12 px-8 py-6 items-center hover:bg-surface-container-low transition-colors cursor-pointer group ${isSelected ? 'bg-primary/5' : ''}" onclick="handleDocClick(event, '${doc.id}')">
            <div class="col-span-8 flex items-center gap-4">
                ${isSelectionMode ? `
                    <input type="checkbox" class="w-5 h-5 rounded border-outline-variant/30 text-primary focus:ring-primary pointer-events-none" ${isSelected ? 'checked' : ''}>
                ` : ''}
                <div class="w-12 h-12 flex-shrink-0 bg-surface-container-highest rounded-xl flex items-center justify-center relative overflow-hidden border border-outline-variant/10 shadow-sm">
                    <div class="text-[9px] font-black text-on-surface-variant/40 uppercase tracking-tighter select-none">${doc.type}</div>
                </div>
                <div>
                    <h4 class="font-bold text-on-surface group-hover:text-primary transition-colors line-clamp-1 break-anywhere max-w-[400px]">${doc.title}</h4>
                    <div class="flex items-center gap-2">
                        <span class="text-[9px] text-on-surface-variant uppercase tracking-widest font-black">${doc.type}</span>
                        ${doc.project ? `<span class="text-[9px] text-primary/60 uppercase tracking-widest font-black">• ${doc.project}</span>` : ''}
                        ${doc.subject ? `<span class="text-[9px] text-on-surface-variant/40 uppercase tracking-widest font-black">• ${doc.subject}</span>` : ''}
                        <span class="text-[9px] text-on-surface-variant/30 uppercase tracking-widest font-black">• ${doc.doc_date || doc.date_added}</span>
                        <span class="text-[9px] text-on-surface-variant/20 uppercase tracking-widest font-black">• v${doc.version_no}</span>
                    </div>
                </div>
            </div>
            <div class="col-span-4 flex items-center justify-end gap-6 text-sm text-on-surface-variant font-medium">
                ${doc.date_added}
                ${!isSelectionMode ? `
                    <button class="delete-doc-btn p-2 text-on-surface-variant/20 hover:text-error rounded-lg transition-all opacity-0 group-hover:opacity-100" data-id="${doc.id}" data-path="${doc.file_path.replace(/\\/g, '\\\\')}">
                        ${getIcon('delete', 'sm')}
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

async function handleFileSelection() {
    const files = await window.api.selectFiles();
    if (files && files.length > 0) {
        const newFiles = files.filter(f => !pendingFiles.some(pf => pf.path === f.path));
        pendingFiles = [...pendingFiles, ...newFiles];
        enterStagingState();
    }
}

function enterStagingState() {
    const wrapper = document.getElementById('upload-wrapper');
    const stagingArea = document.getElementById('staging-area');
    const heroHeader = document.getElementById('hero-header');
    const hint = document.getElementById('ready-hint');
    const icon = document.getElementById('upload-icon');

    if (wrapper) wrapper.classList.add('staging-active');
    if (stagingArea) stagingArea.classList.add('visible');
    if (heroHeader) {
        heroHeader.style.opacity = '0';
        heroHeader.style.maxHeight = '0';
        heroHeader.style.marginBottom = '0';
    }
    if (hint) hint.style.opacity = '0';
    const iconWrapper = document.getElementById('upload-icon-container');
    if (iconWrapper) iconWrapper.innerHTML = getIcon('cloud_upload', 'xl');

    // Reset force Ai toggler
    forceAiForNextUpload = false;
    const forceToggle = document.getElementById('force-ai-toggle');
    if (forceToggle) {
        forceToggle.classList.remove('bg-primary', 'text-white', 'shadow-md');
        forceToggle.classList.add('bg-surface-container-low', 'text-on-surface-variant');
        forceToggle.onclick = (e) => {
            e.stopPropagation();
            forceAiForNextUpload = !forceAiForNextUpload;
            if (forceAiForNextUpload) {
                forceToggle.classList.remove('bg-surface-container-low', 'text-on-surface-variant');
                forceToggle.classList.add('bg-primary', 'text-white', 'shadow-md');
            } else {
                forceToggle.classList.remove('bg-primary', 'text-white', 'shadow-md');
                forceToggle.classList.add('bg-surface-container-low', 'text-on-surface-variant');
            }
        };
    }

    renderPendingList();

    const confirmBtn = document.getElementById('confirm-upload-btn');
    if (confirmBtn) confirmBtn.onclick = confirmUploads;

    const cancelBtn = document.getElementById('cancel-upload-btn');
    if (cancelBtn) cancelBtn.onclick = resetAddView;
}

function resetAddView() {
    pendingFiles = [];

    // Remove any loading state first (btn-loading class, disabled buttons)
    resetLoadingState();

    // Reset staging UI in-place without re-rendering the entire view
    const wrapper = document.getElementById('upload-wrapper');
    const stagingArea = document.getElementById('staging-area');
    const heroHeader = document.getElementById('hero-header');
    const hint = document.getElementById('ready-hint');
    const iconWrapper = document.getElementById('upload-icon-container');
    const pendingList = document.getElementById('pending-list');
    const confirmBtn = document.getElementById('confirm-upload-btn');
    const cancelBtn = document.getElementById('cancel-upload-btn');

    if (wrapper) wrapper.classList.remove('staging-active');
    if (stagingArea) stagingArea.classList.remove('visible');
    if (heroHeader) {
        heroHeader.style.opacity = '';
        heroHeader.style.maxHeight = '';
        heroHeader.style.marginBottom = '';
    }
    if (hint) hint.style.opacity = '';
    // Icon back to the '+' symbol
    if (iconWrapper) iconWrapper.innerHTML = getIcon('add', 'xl');
    if (pendingList) pendingList.innerHTML = '';
    // Re-enable action buttons (in case they were disabled during upload)
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;

    // Re-bind the upload button
    const upBtn = document.getElementById('main-upload-btn');
    if (upBtn) {
        upBtn.classList.remove('btn-loading');
        upBtn.onclick = handleFileSelection;
    }
}

async function confirmUploads() {
    if (pendingFiles.length === 0) return;

    // UI Loading State
    const confirmBtn = document.getElementById('confirm-upload-btn');
    const cancelBtn = document.getElementById('cancel-upload-btn');
    const mainUploadBtn = document.getElementById('main-upload-btn');
    const iconContainer = document.getElementById('upload-icon-container');

    if (confirmBtn) confirmBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (mainUploadBtn) mainUploadBtn.classList.add('btn-loading');
    if (iconContainer) {
        iconContainer.innerHTML = getIcon('add', 'xl');
    }

    console.log("Archive sequence started for", pendingFiles.length, "files");
    showToast('archiving_msg', { count: pendingFiles.length }, 0);

    try {
        const result = await window.api.processUploads(pendingFiles, forceAiForNextUpload);
        console.log("Backend process-uploads result:", result);

        if (result && result.success) {
            showToast("staged_msg", {}, 4000);
            // Reset the add view cleanly — shows '+' button again
            resetAddView();
            // Show the 'View Library' shortcut in the toast
            const statusActions = document.getElementById('status-actions');
            if (statusActions) statusActions.classList.remove('hidden');
        } else {
            console.error("Archive failed: Result unsuccessful", result);
            showToast("Error processing files.", {}, 3000);
            resetLoadingState();
        }
    } catch (err) {
        console.error("Fatal error during confirmUploads:", err);
        showToast("System error. Check console.", {}, 3000);
        resetLoadingState();
    }
}

function resetLoadingState() {
    const confirmBtn = document.getElementById('confirm-upload-btn');
    const cancelBtn = document.getElementById('cancel-upload-btn');
    const mainUploadBtn = document.getElementById('main-upload-btn');
    const iconContainer = document.getElementById('upload-icon-container');

    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (mainUploadBtn) mainUploadBtn.classList.remove('btn-loading');
    if (iconContainer) {
        iconContainer.innerHTML = getIcon('cloud_upload', 'xl');
    }
}

function renderPendingList() {
    const container = document.getElementById('pending-list');
    if (!container) return;
    container.innerHTML = pendingFiles.map((file, index) => {
        const ext = file.name.split('.').pop().toLowerCase();
        const icon = (ext === 'pdf') ? 'picture_as_pdf' : 'image';
        return `
            <div class="px-8 py-4 flex items-center justify-between group">
                <div class="flex items-center gap-4">
                    <div class="text-primary opacity-40">
                        ${getIcon(icon)}
                    </div>
                    <div>
                        <p class="text-sm font-semibold text-on-surface truncate max-w-md">${file.name}</p>
                        <p class="text-[10px] text-on-surface-variant font-bold uppercase tracking-tight">
                            ${(file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                    </div>
                </div>
                <button class="text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 transition-all font-bold text-xs" onclick="pendingFiles.splice(${index}, 1); renderPendingList(); if(pendingFiles.length === 0) resetAddView();">
                    ${t('remove')}
                </button>
            </div>
        `;
    }).join('');
}

// --- AI / Analytics Logic Removed as standalone search is merged ---

function selectDocument(id, isSoftUpdate = false) {
    activeDocId = id; // Update active tracker
    const doc = documents.find(d => d.id == id);
    if (!doc) return;

    const isProcessing = doc.status === 'processing';

    const animationClass = isSoftUpdate ? 'content-update-fade' : 'animate-fade-in';

    const detailHTML = `
        <div class="space-y-6 ${animationClass} pb-12">
            <!-- Premium Metadata Header -->
            <div class="space-y-4">
                <div class="flex items-center gap-3">
                    <span class="px-2.5 py-1 bg-primary/10 text-primary text-[10px] font-black rounded-full uppercase tracking-widest border border-primary/20">
                        ${isProcessing ? 'SCANNING...' : doc.type}
                    </span>
                    ${!isProcessing && doc.class ? `
                    <span class="px-2.5 py-1 bg-surface-container-highest text-on-surface-variant text-[10px] font-black rounded-full tracking-widest border border-outline-variant/10">
                        ${doc.class}
                    </span>` : ''}
                    <span class="h-px flex-1 bg-outline-variant/10"></span>
                </div>
                
                <h2 class="font-headline font-extrabold text-3xl tracking-tight text-on-surface leading-tight break-anywhere">
                    ${isProcessing ? (doc.file?.replace(/_/g, ' ').replace(/-/g, ' ') || 'Intelligence Extraction...') : doc.title}
                </h2>
                
                ${!isProcessing ? `
                <!-- ===== ركن البيانات الإدارية (Smart Administrative Data) ===== -->
                <div class="mt-6 space-y-3">
                    <div class="flex items-center gap-2 mb-4">
                        <span class="text-[10px] font-black uppercase tracking-widest text-primary/60">${currentLang === 'ar' ? 'البيانات التحليلية' : 'Analytical Data'}</span>
                        <div class="h-px flex-1 bg-outline-variant/10"></div>
                        <span class="text-[8px] text-on-surface-variant/30 font-bold">${currentLang === 'ar' ? 'كليك يمين للتعديل' : 'Right-click to edit'}</span>
                    </div>

                                    <!-- الموضوع -->
                    <div id="field-subject-${doc.id}" class="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/5 hover:border-primary/20 transition-all group/field cursor-context-menu" oncontextmenu="event.preventDefault(); openFieldEditor(this, '${doc.id}', 'subject', \`${(doc.subject || '').replace(/`/g, "'")}\`, '${currentLang === 'ar' ? 'الموضوع' : 'Subject'}')" title="${currentLang === 'ar' ? 'كليك يمين للتعديل' : 'Right-click to edit'}">
                        <div class="flex items-center justify-between gap-3 mb-1">
                            <div class="flex items-center gap-2">
                                <div class="text-primary/40 group-hover/field:text-primary transition-colors">${getIcon('subject', 'xs')}</div>
                                <span class="text-[9px] font-black uppercase tracking-widest text-on-surface-variant/40">${currentLang === 'ar' ? 'الموضوع' : 'Subject'}</span>
                            </div>

                        </div>
                        <p class="field-value text-sm font-bold text-on-surface leading-snug pl-7">${doc.subject || '—'}</p>
                    </div>

                    <!-- المشروع / الجهة -->
                    <div id="field-project-${doc.id}" class="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/5 hover:border-primary/20 transition-all group/field cursor-context-menu" oncontextmenu="event.preventDefault(); openFieldEditor(this, '${doc.id}', 'project', \`${(doc.project || '').replace(/`/g, "'")}\`, '${currentLang === 'ar' ? 'المشروع / الجهة' : 'Project / Entity'}')" title="${currentLang === 'ar' ? 'كليك يمين للتعديل' : 'Right-click to edit'}">
                        <div class="flex items-center justify-between gap-3 mb-1">
                            <div class="flex items-center gap-2">
                                <div class="text-primary/40 group-hover/field:text-primary transition-colors">${getIcon('business', 'xs')}</div>
                                <span class="text-[9px] font-black uppercase tracking-widest text-on-surface-variant/40">${currentLang === 'ar' ? 'المشروع / الجهة' : 'Project / Entity'}</span>
                            </div>

                        </div>
                        <p class="field-value text-sm font-bold text-on-surface leading-snug pl-7">${doc.project || '—'}</p>
                    </div>

                    <!-- التاريخ ورقم المرجع (Dynamic Expanding Layout) -->
                    <div class="flex gap-2">
                        <!-- التاريخ -->
                        <div id="field-doc_date-${doc.id}" class="flex-1 min-w-0 p-4 rounded-2xl bg-surface-container-low border border-outline-variant/5 hover:border-primary/20 transition-all duration-500 hover:flex-[2.5] group/field cursor-context-menu" oncontextmenu="event.preventDefault(); openFieldEditor(this, '${doc.id}', 'doc_date', '${doc.doc_date || ''}', '${currentLang === 'ar' ? 'التاريخ' : 'Date'}')" title="${currentLang === 'ar' ? 'كليك يمين للتعديل' : 'Right-click to edit'}">
                            <div class="flex items-center justify-between gap-2 mb-1">
                                <span class="text-[9px] font-black uppercase tracking-widest text-on-surface-variant/40 group-hover/field:text-primary transition-colors">${currentLang === 'ar' ? 'التاريخ' : 'Date'}</span>
    
                            </div>
                            <p class="field-value text-xs font-bold text-on-surface font-mono truncate group-hover/field:whitespace-normal">${doc.doc_date || '—'}</p>
                        </div>
                        <!-- الرقم -->
                        <div id="field-version_no-${doc.id}" class="flex-1 min-w-0 p-4 rounded-2xl bg-surface-container-low border border-outline-variant/5 hover:border-primary/20 transition-all duration-500 hover:flex-[2.5] group/field cursor-context-menu" oncontextmenu="event.preventDefault(); openFieldEditor(this, '${doc.id}', 'version_no', '${doc.version_no || ''}', '${currentLang === 'ar' ? 'الرقم' : 'Reference'}')" title="${currentLang === 'ar' ? 'كليك يمين للتعديل' : 'Right-click to edit'}">
                            <div class="flex items-center justify-between gap-2 mb-1">
                                <span class="text-[9px] font-black uppercase tracking-widest text-on-surface-variant/40 group-hover/field:text-primary transition-colors">${currentLang === 'ar' ? 'الرقم' : 'Reference'}</span>
    
                            </div>
                            <p class="field-value text-xs font-bold text-primary truncate group-hover/field:whitespace-normal">${doc.version_no || '—'}</p>
                        </div>
                    </div>

                    <!-- مسار الملف (File Path) -->
                    <div class="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/5 group/field">
                        <div class="flex items-center justify-between gap-3 mb-1">
                            <div class="flex items-center gap-2">
                                <div class="text-primary/40 group-hover/field:text-primary transition-colors">${getIcon('folder', 'xs')}</div>
                                <span class="text-[9px] font-black uppercase tracking-widest text-on-surface-variant/40">${t('file_path')}</span>
                            </div>
                            <button class="w-8 h-8 flex items-center justify-center text-primary/40 hover:text-primary hover:bg-primary/5 rounded-lg transition-all" onclick="copyToClipboard('${doc.file_path.replace(/\\/g, '\\\\')}', this)" title="${t('copy_path')}">
                                ${getIcon('content_copy', 'xs')}
                            </button>
                        </div>
                        <p class="text-[10px] font-bold text-on-surface-variant/40 break-all leading-relaxed pl-7 transition-opacity">${doc.file_path}</p>
                    </div>
                    
                    <!-- زر فتح المجلد الخارجي (Open Folder Full Width Button) -->
                    <button class="w-full py-3 bg-primary text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-md shadow-primary/20 hover:bg-primary-dim active:scale-95 transition-all flex items-center justify-center gap-2" onclick="window.api.showItemInFolder('${doc.file_path.replace(/\\/g, '\\\\')}')">
                        <span>${t('open_folder')}</span>
                    </button>
                </div>
                ` : ''}
            </div>
            
            <div class="h-px bg-outline-variant/10"></div>
            
            <!-- ملخص المحتوى (Content Summary) -->
            <div class="p-6 bg-primary/5 rounded-3xl border border-primary/10 group/summary hover:bg-primary/8 transition-all">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-2 text-primary">
                        <div class="sm">${getIcon('description')}</div>
                        <span class="text-[10px] font-black uppercase tracking-widest">${currentLang === 'ar' ? 'ملخص المحتوى' : 'Content Summary'}</span>
                    </div>
                </div>
                
                ${isProcessing ? `
                    <div class="space-y-2">
                        <div class="h-3 w-full summary-loading-gradient"></div>
                        <div class="h-3 w-5/6 summary-loading-gradient"></div>
                    </div>
                ` : `
                    <p class="text-[14px] leading-relaxed text-on-surface font-bold italic">
                        "${doc.summary || (currentLang === 'ar' ? 'لا يوجد ملخص متاح حالياً لهذه الوثيقة.' : 'No summary available for this document.')}"
                    </p>
                `}
            </div>

            <div class="space-y-4">
                <h4 class="text-[10px] font-black uppercase tracking-widest text-on-surface-variant/40 font-label">${t('action_control')}</h4>
                <div class="grid grid-cols-2 gap-3">
                    <div class="flex items-center gap-2 col-span-2">
                        <button class="flex-1 py-4 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary-dim active:scale-95 transition-all flex items-center justify-center gap-2" onclick="window.api.openPath('${doc.file_path.replace(/\\/g, '\\\\')}')">
                            <span>${t('open_file')}</span>
                        </button>
                        <button id="re-analyze-btn" class="w-14 h-14 bg-primary/5 text-primary flex items-center justify-center rounded-xl hover:bg-primary/20 active:scale-95 transition-all group/re border border-primary/20 shadow-lg shadow-primary/5" title="${currentLang === 'ar' ? 'تحليل ذكي' : 'AI Analysis'}">
                            <div class="group-hover/re:scale-110 group-hover/re:rotate-[15deg] transition-transform duration-500">
                                ${getIcon('auto_awesome', 'sm')}
                            </div>
                        </button>
                    </div>
                    <button class="col-span-2 py-4 border border-outline-variant/10 text-on-surface-variant text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-surface-container-high active:scale-95 transition-all export-action-btn flex items-center justify-center gap-2">
                        <span>${t('export')}</span>
                    </button>
                </div>
                <p class="text-center text-[9px] text-on-surface-variant/40 font-bold">${t('last_analyzed')}: ${doc.date_added}</p>
            </div>
        </div>
    `;

    const insights = document.getElementById('global-insights');
    const intel = document.getElementById('document-intelligence');
    detailsContainer = document.getElementById('sidebar-doc-details');

    if (insights && intel && detailsContainer) {
        insights.classList.add('hidden');
        intel.classList.remove('hidden');
        detailsContainer.innerHTML = detailHTML;
    }

    if (detailsContainer) {
        const exportBtn = detailsContainer.querySelector('.export-action-btn');
        if (exportBtn) {
            exportBtn.onclick = async () => {
                const fileName = doc.file_path.split(/[\\/]/).pop();
                const result = await window.api.exportFile(doc.file_path, fileName);
                if (result.success) {
                    showToast("exported_msg");
                }
            };
        }

        const reanalyzeBtn = detailsContainer.querySelector('#re-analyze-btn');
        if (reanalyzeBtn && !isProcessing) {
            reanalyzeBtn.onclick = async (e) => {
                e.stopPropagation();
                // Play visual feedback immediately
                reanalyzeBtn.classList.add('bg-primary/20', 'scale-95');
                setTimeout(() => reanalyzeBtn.classList.remove('bg-primary/20', 'scale-95'), 150);
                
                showToast(currentLang === 'ar' ? 'جاري الفحص الدقيق...' : 'Running Deep Intelligence Scan...', {}, 3000);
                
                await window.api.reprocessDocument(doc.id, doc.file_path);
                
                // Switch local UI instantly while waiting for backend
                doc.status = 'processing';
                selectDocument(doc.id, true); // use soft update
            };
        }

    // Duplication removed
    }
    if (insightRail) insightRail.classList.add('translate-x-full');
}


// ============================================================
// INLINE FIELD EDITOR (Right-click to edit)
// ============================================================
window.openFieldEditor = function (cardEl, docId, fieldKey, currentValue, fieldLabel) {
    // Prevent double-opening
    if (cardEl.querySelector('input, textarea')) return;

    const valueEl = cardEl.querySelector('.field-value');
    if (!valueEl) return;

    const isMultiline = ['subject', 'project'].includes(fieldKey);
    const inputEl = document.createElement(isMultiline ? 'textarea' : 'input');

    // Style to match the card
    inputEl.value = (currentValue === '—' || !currentValue) ? '' : currentValue;
    inputEl.className = `w-full bg-transparent text-sm font-bold text-on-surface outline-none border-b-2 border-primary resize-none mt-1 placeholder:text-on-surface-variant/30 ${isMultiline ? 'min-h-[3rem]' : ''}`;
    inputEl.placeholder = `${currentLang === 'ar' ? 'أدخل' : 'Enter'} ${fieldLabel}...`;
    if (isMultiline) inputEl.rows = 2;

    // Replace value text with input
    valueEl.replaceWith(inputEl);
    inputEl.focus();
    inputEl.select();

    // Highlight the card
    cardEl.classList.add('border-primary/40', 'bg-primary/5');
    cardEl.classList.remove('hover:border-primary/20');

    // Create action buttons
    const actions = document.createElement('div');
    actions.className = 'flex gap-2 mt-3 justify-end';
    actions.innerHTML = `
        <button id="cancel-edit-${fieldKey}" class="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-on-surface-variant/60 hover:text-error bg-surface-container rounded-lg transition-all">
            ${currentLang === 'ar' ? 'إلغاء' : 'Cancel'}
        </button>
        <button id="save-edit-${fieldKey}" class="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-white bg-primary rounded-lg hover:opacity-90 active:scale-95 transition-all shadow-sm shadow-primary/30">
            ${currentLang === 'ar' ? 'حفظ' : 'Save'}
        </button>
    `;
    cardEl.appendChild(actions);

    const cancelFn = () => {
        // Restore original value display
        const p = document.createElement('p');
        p.className = `field-value ${isMultiline ? 'text-sm' : 'text-xs'} font-bold text-on-surface leading-snug ${isMultiline ? 'pl-7' : 'truncate group-hover/field:whitespace-normal'}`;
        if (fieldKey === 'version_no') p.classList.add('text-primary');
        p.textContent = currentValue || '—';
        inputEl.replaceWith(p);
        actions.remove();
        cardEl.classList.remove('border-primary/40', 'bg-primary/5');
        cardEl.classList.add('hover:border-primary/20');
    };

    const saveFn = async () => {
        const newValue = inputEl.value.trim();
        if (newValue === currentValue) { cancelFn(); return; }

        const saveBtn = document.getElementById(`save-edit-${fieldKey}`);
        if (saveBtn) {
            saveBtn.textContent = currentLang === 'ar' ? '...' : '...';
            saveBtn.disabled = true;
        }

        try {
            const result = await window.api.updateDocument(docId, { [fieldKey]: newValue });
            if (result.success) {
                // Update display
                const p = document.createElement('p');
                p.className = `field-value ${isMultiline ? 'text-sm' : 'text-xs'} font-bold text-on-surface leading-snug`;
                if (fieldKey === 'version_no') p.classList.add('text-primary');
                p.textContent = newValue || '—';
                inputEl.replaceWith(p);
                actions.remove();
                cardEl.classList.remove('border-primary/40', 'bg-primary/5');
                cardEl.classList.add('hover:border-primary/20');
                showToast('storage_updated');
                // Update local cache
                const doc = documents.find(d => d.id == docId);
                if (doc) doc[fieldKey] = newValue;
            } else {
                showToast('delete_confirm'); // fallback toast
                cancelFn();
            }
        } catch (e) {
            cancelFn();
        }
    };

    document.getElementById(`save-edit-${fieldKey}`)?.addEventListener('click', saveFn);
    document.getElementById(`cancel-edit-${fieldKey}`)?.addEventListener('click', cancelFn);

    // Save on Enter (for single-line fields), cancel on Escape
    inputEl.addEventListener('keydown', (e) => {
        if (!isMultiline && e.key === 'Enter') { e.preventDefault(); saveFn(); }
        if (e.key === 'Escape') cancelFn();
    });
};

async function handleDeleteDocument(id, filePath) {
    if (await confirmAction('confirm_title', 'delete_confirm')) {
        const result = await window.api.deleteDocument(id, filePath);
        if (result.success) {
            showToast('delete_success');
        } else {
            alert('Delete failed: ' + result.error);
        }
    }
}

async function handleBatchDelete() {
    if (selectedDocIds.size === 0) return;
    if (await confirmAction('confirm_title', 'delete_confirm')) {
        const docsToDelete = documents.filter(d => selectedDocIds.has(d.id.toString()));
        const result = await window.api.deleteMultipleDocuments(docsToDelete);
        if (result.success) {
            showToast('delete_success');
            exitSelectionMode();
        } else {
            alert('Batch delete failed');
        }
    }
}

function handleDocClick(event, id) {
    if (isSelectionMode) {
        const sid = id.toString();
        if (selectedDocIds.has(sid)) selectedDocIds.delete(sid);
        else selectedDocIds.add(sid);
        renderArchiveView(document.getElementById('global-search-input')?.value || '');
    } else {
        selectDocument(id);
    }
}

function exitSelectionMode() {
    isSelectionMode = false;
    selectedDocIds.clear();
    renderArchiveView(document.getElementById('global-search-input')?.value || '');
}

async function handleClearArchive() {
    if (isSelectionMode) {
        exitSelectionMode();
        return;
    }
    isSelectionMode = true;
    renderArchiveView(document.getElementById('global-search-input')?.value || '');
}

if (window.api) {
    let lastDocCount = 0;
    window.api.onDocumentsUpdate((updatedDocs) => {
        const newDocs = updatedDocs || [];
        const prevDocs = documents;
        documents = newDocs;
        lastDocCount = newDocs.length;

        // Refresh archive view only if we're already on it
        if (currentView === 'archive') {
            renderArchiveView(document.getElementById('global-search-input')?.value || '');
            buildDynamicFilterMenu(); // Refresh dynamic filter chips with new data
        }

        // Auto-refresh the detail rail if the active doc just finished processing
        if (activeDocId && currentView === 'archive') {
            const activeDoc = documents.find(d => d.id == activeDocId);
            const prevDoc = prevDocs.find(d => d.id == activeDocId);
            if (activeDoc && prevDoc && prevDoc.status === 'processing' && activeDoc.status !== 'processing') {
                selectDocument(activeDocId, true); // soft update on finish
            } else if (activeDoc && !prevDoc) {
                selectDocument(activeDocId, true);
            }
        }
    });
    window.api.onStatusUpdate((status) => {
        if (!status) return;
        const msgKey = typeof status === 'string' ? status : status.msg;
        const progress = status.progress || 0;

        // Use t() for localized status messages
        if (statusText) statusText.innerText = t(msgKey, status);

        if (statusToast) {
            statusToast.style.opacity = '1';
            statusToast.style.pointerEvents = 'auto';
            statusToast.style.transform = 'translateX(-50%) scale(1)';
        }

        if (status.doc_id) {
            // Show action buttons if something is being processed
            const statusActions = document.getElementById('status-actions');
            if (statusActions) statusActions.classList.remove('hidden');

            // If the processing document is the one open in the rail, refresh it
            if (activeDocId == status.doc_id) {
                if (progress === 100 || msgKey.toLowerCase().includes('success')) {
                    selectDocument(activeDocId);
                }
            }
        }

        if (progress > 0 && progress < 100) {
            if (progressContainer) progressContainer.classList.remove('hidden');
            const fill = document.getElementById('progress-bar');
            if (fill) fill.style.width = `${progress}%`;
        } else {
            if (progressContainer) progressContainer.classList.add('hidden');
            if (['status_idle', 'status_error', 'status_fail'].includes(msgKey) || progress === 100 || progress === 0) {
                setTimeout(() => {
                    // Only hide if still idle or finished
                    if (statusToast && (progress === 100 || progress === 0)) {
                        statusToast.style.opacity = '0';
                        statusToast.style.pointerEvents = 'none';
                        statusToast.style.transform = 'translateX(-50%) scale(0.9)';

                        // Hide actions after toast slides out
                        setTimeout(() => {
                            const statusActions = document.getElementById('status-actions');
                            if (statusActions) statusActions.classList.add('hidden');
                        }, 700);
                    }
                }, 4000);
            }
        }
    });

    // Initialize Status
    if (statusText) statusText.innerText = t('status_idle');
    window.api.getDocuments().then(docs => { documents = docs || []; });
}

document.getElementById('nav-add').onclick = () => switchView('add');
document.getElementById('nav-archive').onclick = () => switchView('archive');
document.getElementById('nav-ai').onclick = () => switchView('ai');

const toastViewBtn = document.getElementById('toast-view-btn');
if (toastViewBtn) toastViewBtn.onclick = () => switchView('archive');

// Settings Listeners
const settingsOpenBtn = document.getElementById('settings-open-btn');
const settingsBackdrop = document.getElementById('settings-backdrop');
const themeLightBtn = document.getElementById('theme-light-btn');
const themeDarkBtn = document.getElementById('theme-dark-btn');
const langEnBtn = document.getElementById('lang-en-btn');
const langArBtn = document.getElementById('lang-ar-btn');

// Selective Delete Listeners
const batchDeleteBtn = document.getElementById('batch-delete-btn');
const batchCancelBtn = document.getElementById('batch-cancel-btn');

if (settingsOpenBtn) settingsOpenBtn.onclick = () => toggleSettingsModal(true);
if (settingsBackdrop) settingsBackdrop.onclick = () => toggleSettingsModal(false);

if (themeLightBtn) themeLightBtn.onclick = () => setTheme('light');
if (themeDarkBtn) themeDarkBtn.onclick = () => setTheme('dark');
if (langEnBtn) langEnBtn.onclick = () => setLanguage('en');
if (langArBtn) langArBtn.onclick = () => setLanguage('ar');

const changeStorageBtn = document.getElementById('change-storage-btn');
if (changeStorageBtn) {
    changeStorageBtn.onclick = async () => {
        const result = await window.api.changeStorageFolder();
        if (result && result.success) {
            showToast('storage_updated');
            refreshStorageDisplay();
            // Refresh documents list from new storage
            window.api.getDocuments().then(docs => {
                documents = docs || [];
                if (currentView === 'archive') renderArchiveView();
            });
        }
    };
}

if (batchDeleteBtn) batchDeleteBtn.onclick = handleBatchDelete;
if (batchCancelBtn) batchCancelBtn.onclick = exitSelectionMode;

// Initialize Theme
setTheme(currentTheme);

const closeRail = document.getElementById('close-rail');
if (closeRail && insightRail) closeRail.onclick = () => insightRail.classList.add('translate-x-full');

updateLayoutDirection();
console.log("Archiva Intelligence Engine Initialized.");

document.addEventListener('click', (e) => {
    const filterMenu = document.getElementById('filter-menu');
    const filterToggle = document.getElementById('toggle-filter-menu');
    if (filterMenu && filterMenu.classList.contains('active')) {
        if (!filterMenu.contains(e.target) && e.target !== filterToggle && !filterToggle.contains(e.target)) {
            filterMenu.classList.remove('active');
        }
    }
});

if (window.api && window.api.sendReady) {
    setTimeout(() => {
        document.body.classList.remove('loading');
        window.api.sendReady();
    }, 250);
}

// ============================================================
// AUTO-ANALYSIS TOGGLE LOGIC
// ============================================================

let _autoAnalysisEnabled = false; // local state mirror

function setAutoAnalysisUI(enabled, activatedAt) {
    _autoAnalysisEnabled = enabled;
    const toggleBtn     = document.getElementById('auto-analysis-toggle');
    const badge         = document.getElementById('auto-analysis-badge');
    const activatedSpan = document.getElementById('auto-analysis-activated-at');
    const descEl        = document.getElementById('auto-analysis-desc');

    if (!toggleBtn) return;

    // Animate the toggle switch
    toggleBtn.classList.toggle('on', enabled);
    toggleBtn.classList.toggle('off', !enabled);
    toggleBtn.setAttribute('aria-checked', String(enabled));

    // Update description text
    if (descEl) descEl.innerText = t(enabled ? 'auto_analysis_on' : 'auto_analysis_off');

    // Show/hide activation timestamp badge
    if (badge && activatedSpan) {
        if (enabled && activatedAt) {
            try {
                const dt = new Date(activatedAt);
                const formatted = dt.toLocaleString(currentLang === 'ar' ? 'ar-SA' : 'en-GB', {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                activatedSpan.innerText = `${t('activated_since')} ${formatted}`;
                badge.classList.remove('hidden');
            } catch (e) {
                badge.classList.add('hidden');
            }
        } else {
            badge.classList.add('hidden');
        }
    }
}

async function initAutoAnalysisToggle() {
    if (!window.api || !window.api.getAutoAnalysisStatus) return;
    try {
        const status = await window.api.getAutoAnalysisStatus();
        setAutoAnalysisUI(status.enabled, status.activatedAt);
    } catch (e) {
        console.error('Failed to load auto-analysis status:', e);
        setAutoAnalysisUI(true, null); // Fallback: show as enabled
    }
}

// Attach click handler to the toggle button
const autoAnalysisToggleBtn = document.getElementById('auto-analysis-toggle');
if (autoAnalysisToggleBtn) {
    autoAnalysisToggleBtn.addEventListener('click', async () => {
        const nextState = !_autoAnalysisEnabled;

        // Immediately flip UI for instant tactile feedback
        setAutoAnalysisUI(nextState, nextState ? new Date().toISOString() : null);

        // Prevent double-clicks during async IPC
        autoAnalysisToggleBtn.disabled = true;
        autoAnalysisToggleBtn.style.opacity = '0.7';

        try {
            const result = await window.api.toggleAutoAnalysis(nextState);
            if (result && result.success) {
                // Sync with actual server response (real activatedAt timestamp)
                setAutoAnalysisUI(result.enabled, result.activatedAt);
                const toastKey = result.enabled
                    ? 'auto_analysis_enabled_toast'
                    : 'auto_analysis_disabled_toast';
                showToast(toastKey, {}, 4000);
            } else {
                // Revert UI on failure
                setAutoAnalysisUI(!nextState, null);
            }
        } catch (e) {
            console.error('Failed to toggle auto-analysis:', e);
            setAutoAnalysisUI(!nextState, null); // revert on error
        } finally {
            autoAnalysisToggleBtn.disabled = false;
            autoAnalysisToggleBtn.style.opacity = '1';
        }
    });
}

// Load and display current status on startup
initAutoAnalysisToggle();