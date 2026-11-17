; 自定义 NSIS 安装脚本：夸克风简洁流程
; 跳过欢迎页，直接路径选择 → 安装 → 完成

!ifndef APPNAME
  !define APPNAME "SFS启动器"
!endif

; 跳过欢迎页和开始菜单页（夸克风：极简）
!define MUI_PAGEWELCOME_TEXT ""

; 完成页
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 SFS 启动器"
!define MUI_FINISHPAGE_RUN_CHECKED 0

; 目录页
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置（建议保持默认）"
!define MUI_DIRECTORYPAGE_TEXT_DESTDIR "安装到(&D):"

; 安装进行页
!define MUI_TEXT_INSTALLING_TITLE "正在安装"
!define MUI_TEXT_INSTALLING_TEXT "正在安装 SFS 启动器，请稍候…"

; 卸载页
!define MUI_UNINSTPAGEWELCOME_TEXT ""
!define MUI_UNFINISHPAGE_TEXT "SFS 启动器已成功卸载"
