# المسار إلى المجلد الذي تريد فلترته
$SourceFolder = "C:\Users\Drafter-5\Desktop\Archiva"  # <<-- غيّر هذا

# إنشاء مجلد مؤقت
$TempFolder = Join-Path -Path $env:TEMP -ChildPath "HiddenFilesOnly"
if (!(Test-Path -Path $TempFolder -PathType Container)) {
    New-Item -ItemType Directory -Path $TempFolder
} else {
    # إذا كان المجلد المؤقت موجودًا بالفعل، فاحذفه أولاً لتجنب التداخل
    Remove-Item -Path $TempFolder -Recurse -Force
    New-Item -ItemType Directory -Path $TempFolder
}

# نسخ الملفات المخفية فقط
Get-ChildItem -Path $SourceFolder -Attributes Hidden | Copy-Item -Destination $TempFolder

# فتح المجلد المؤقت في File Explorer
Invoke-Item $TempFolder