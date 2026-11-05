/**
 * 主进程原生 UI 的词条（托盘菜单 + 两个文件选择框）。
 * 渲染层词条在 src/i18n/locales；这里只放 Electron 原生界面用得到的少量文案，
 * 语言清单必须与 main.cjs 的 LANGUAGE_PREFERENCES 和渲染层 languages.ts 一致。
 */

const SUPPORTED_LANGUAGES = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "ru",
  "de",
  "fr",
  "es",
  "pt",
  "hi",
];

const MAIN_STRINGS = {
  "zh-CN": {
    newChat: "新对话",
    recentChats: "最近对话",
    moreChats: "更多",
    untitledSession: "未命名会话",
    notifTurnDone: "回合已完成，等待你的输入",
    notifTurnAborted: "回合已被中断",
    notifTurnError: "回合执行出错",
    notifApproval: "需要你确认",
    notifAsk: "需要你回答",
    exportSession: "导出会话",
    markdownFiles: "Markdown 文件",
    htmlFiles: "HTML 文件",
    jsonFiles: "JSON 文件",
    showWindow: "显示 MeowCode",
    settings: "设置…",
    quit: "退出",
    pickWorkspace: "选择 MeowCode 工作区",
    importFont: "选择字体文件",
    fontFiles: "字体文件",
  },
  "zh-TW": {
    newChat: "新對話",
    recentChats: "最近對話",
    moreChats: "更多",
    untitledSession: "未命名對話",
    notifTurnDone: "回合已完成，等待你的輸入",
    notifTurnAborted: "回合已被中斷",
    notifTurnError: "回合執行出錯",
    notifApproval: "需要你確認",
    notifAsk: "需要你回答",
    exportSession: "匯出對話",
    markdownFiles: "Markdown 檔案",
    htmlFiles: "HTML 檔案",
    jsonFiles: "JSON 檔案",
    showWindow: "顯示 MeowCode",
    settings: "設定…",
    quit: "結束",
    pickWorkspace: "選擇 MeowCode 工作區",
    importFont: "選擇字型檔案",
    fontFiles: "字型檔案",
  },
  en: {
    newChat: "New chat",
    recentChats: "Recent chats",
    moreChats: "More",
    untitledSession: "Untitled session",
    notifTurnDone: "Turn finished — waiting for your input",
    notifTurnAborted: "Turn interrupted",
    notifTurnError: "Turn failed",
    notifApproval: "Needs your approval",
    notifAsk: "Your answer is needed",
    exportSession: "Export conversation",
    markdownFiles: "Markdown file",
    htmlFiles: "HTML file",
    jsonFiles: "JSON file",
    showWindow: "Show MeowCode",
    settings: "Settings…",
    quit: "Quit",
    pickWorkspace: "Choose a MeowCode workspace",
    importFont: "Choose a font file",
    fontFiles: "Font files",
  },
  ja: {
    newChat: "新しい会話",
    recentChats: "最近の会話",
    moreChats: "その他",
    untitledSession: "無題のセッション",
    notifTurnDone: "ターンが完了しました。入力待ちです",
    notifTurnAborted: "ターンが中断されました",
    notifTurnError: "ターンでエラーが発生しました",
    notifApproval: "確認が必要です",
    notifAsk: "回答が必要です",
    exportSession: "会話をエクスポート",
    markdownFiles: "Markdown ファイル",
    htmlFiles: "HTML ファイル",
    jsonFiles: "JSON ファイル",
    showWindow: "MeowCode を表示",
    settings: "設定…",
    quit: "終了",
    pickWorkspace: "MeowCode ワークスペースを選択",
    importFont: "フォントファイルを選択",
    fontFiles: "フォントファイル",
  },
  ko: {
    newChat: "새 대화",
    recentChats: "최근 대화",
    moreChats: "더 보기",
    untitledSession: "제목 없는 세션",
    notifTurnDone: "턴이 완료되었습니다. 입력을 기다리는 중",
    notifTurnAborted: "턴이 중단되었습니다",
    notifTurnError: "턴 실행 중 오류가 발생했습니다",
    notifApproval: "확인이 필요합니다",
    notifAsk: "답변이 필요합니다",
    exportSession: "대화 내보내기",
    markdownFiles: "Markdown 파일",
    htmlFiles: "HTML 파일",
    jsonFiles: "JSON 파일",
    showWindow: "MeowCode 표시",
    settings: "설정…",
    quit: "종료",
    pickWorkspace: "MeowCode 워크스페이스 선택",
    importFont: "글꼴 파일 선택",
    fontFiles: "글꼴 파일",
  },
  ru: {
    newChat: "Новый чат",
    recentChats: "Недавние чаты",
    moreChats: "Ещё",
    untitledSession: "Сеанс без названия",
    notifTurnDone: "Ход завершён, ждём вашего ввода",
    notifTurnAborted: "Ход прерван",
    notifTurnError: "Ошибка при выполнении хода",
    notifApproval: "Требуется подтверждение",
    notifAsk: "Нужен ваш ответ",
    exportSession: "Экспорт диалога",
    markdownFiles: "Файл Markdown",
    htmlFiles: "Файл HTML",
    jsonFiles: "Файл JSON",
    showWindow: "Показать MeowCode",
    settings: "Настройки…",
    quit: "Выход",
    pickWorkspace: "Выбрать рабочую область MeowCode",
    importFont: "Выбрать файл шрифта",
    fontFiles: "Файлы шрифтов",
  },
  de: {
    newChat: "Neuer Chat",
    recentChats: "Letzte Chats",
    moreChats: "Mehr",
    untitledSession: "Unbenannte Sitzung",
    notifTurnDone: "Durchlauf abgeschlossen – warte auf dich",
    notifTurnAborted: "Durchlauf unterbrochen",
    notifTurnError: "Fehler beim Durchlauf",
    notifApproval: "Bestätigung erforderlich",
    notifAsk: "Deine Antwort wird benötigt",
    exportSession: "Unterhaltung exportieren",
    markdownFiles: "Markdown-Datei",
    htmlFiles: "HTML-Datei",
    jsonFiles: "JSON-Datei",
    showWindow: "MeowCode anzeigen",
    settings: "Einstellungen…",
    quit: "Beenden",
    pickWorkspace: "MeowCode-Workspace auswählen",
    importFont: "Schriftdatei wählen",
    fontFiles: "Schriftdateien",
  },
  fr: {
    newChat: "Nouvelle conversation",
    recentChats: "Conversations récentes",
    moreChats: "Plus",
    untitledSession: "Session sans titre",
    notifTurnDone: "Tour terminé — en attente de votre saisie",
    notifTurnAborted: "Tour interrompu",
    notifTurnError: "Erreur pendant le tour",
    notifApproval: "Confirmation requise",
    notifAsk: "Votre réponse est attendue",
    exportSession: "Exporter la conversation",
    markdownFiles: "Fichier Markdown",
    htmlFiles: "Fichier HTML",
    jsonFiles: "Fichier JSON",
    showWindow: "Afficher MeowCode",
    settings: "Paramètres…",
    quit: "Quitter",
    pickWorkspace: "Choisir un espace de travail MeowCode",
    importFont: "Choisir un fichier de police",
    fontFiles: "Fichiers de police",
  },
  es: {
    newChat: "Nuevo chat",
    recentChats: "Chats recientes",
    moreChats: "Más",
    untitledSession: "Sesión sin título",
    notifTurnDone: "Turno completado — esperando tu respuesta",
    notifTurnAborted: "Turno interrumpido",
    notifTurnError: "Error al ejecutar el turno",
    notifApproval: "Necesita tu confirmación",
    notifAsk: "Se necesita tu respuesta",
    exportSession: "Exportar conversación",
    markdownFiles: "Archivo Markdown",
    htmlFiles: "Archivo HTML",
    jsonFiles: "Archivo JSON",
    showWindow: "Mostrar MeowCode",
    settings: "Ajustes…",
    quit: "Salir",
    pickWorkspace: "Elegir un espacio de trabajo de MeowCode",
    importFont: "Elegir un archivo de fuente",
    fontFiles: "Archivos de fuente",
  },
  pt: {
    newChat: "Novo chat",
    recentChats: "Chats recentes",
    moreChats: "Mais",
    untitledSession: "Sessão sem título",
    notifTurnDone: "Turno concluído — aguardando você",
    notifTurnAborted: "Turno interrompido",
    notifTurnError: "Erro ao executar o turno",
    notifApproval: "Precisa da sua confirmação",
    notifAsk: "Sua resposta é necessária",
    exportSession: "Exportar conversa",
    markdownFiles: "Arquivo Markdown",
    htmlFiles: "Arquivo HTML",
    jsonFiles: "Arquivo JSON",
    showWindow: "Mostrar MeowCode",
    settings: "Configurações…",
    quit: "Sair",
    pickWorkspace: "Escolher um workspace do MeowCode",
    importFont: "Escolher um arquivo de fonte",
    fontFiles: "Arquivos de fonte",
  },
  hi: {
    newChat: "नया चैट",
    recentChats: "हाल के चैट",
    moreChats: "और",
    untitledSession: "बिना शीर्षक सत्र",
    notifTurnDone: "टर्न पूरा हुआ — आपके इनपुट की प्रतीक्षा",
    notifTurnAborted: "टर्न बीच में रोका गया",
    notifTurnError: "टर्न चलाने में त्रुटि",
    notifApproval: "आपकी पुष्टि चाहिए",
    notifAsk: "आपका उत्तर चाहिए",
    exportSession: "बातचीत निर्यात करें",
    markdownFiles: "Markdown फ़ाइल",
    htmlFiles: "HTML फ़ाइल",
    jsonFiles: "JSON फ़ाइल",
    showWindow: "MeowCode दिखाएँ",
    settings: "सेटिंग्स…",
    quit: "बाहर निकलें",
    pickWorkspace: "MeowCode वर्कस्पेस चुनें",
    importFont: "फ़ॉन्ट फ़ाइल चुनें",
    fontFiles: "फ़ॉन्ट फ़ाइलें",
  },
};

/** 单个 BCP-47 标签 → 支持的语种；无法归类返回 null（与渲染层 matchTag 同规则）。 */
function matchLanguage(tag) {
  const normalized = String(tag || "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
  if (!normalized) return null;
  if (SUPPORTED_LANGUAGES.includes(normalized)) return normalized;

  const [base, region, script] = normalized.split("-");
  if (base === "zh") {
    if (region === "tw" || region === "hk" || region === "mo" || script === "hant" || normalized.includes("hant")) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  return SUPPORTED_LANGUAGES.find((code) => code === base) || null;
}

/** 偏好 + 系统语言 → 主进程实际使用的语种；system 按系统语言顺序取第一个能归类的。 */
function resolveMainLanguage(preference, systemLanguages) {
  if (typeof preference === "string" && SUPPORTED_LANGUAGES.includes(preference)) {
    return preference;
  }
  const tags = Array.isArray(systemLanguages) ? systemLanguages : [systemLanguages];
  for (const tag of tags) {
    const matched = matchLanguage(tag);
    if (matched) return matched;
  }
  return "zh-CN";
}

function mainStrings(preference, systemLanguages) {
  return MAIN_STRINGS[resolveMainLanguage(preference, systemLanguages)] || MAIN_STRINGS["zh-CN"];
}

module.exports = {
  SUPPORTED_LANGUAGES,
  MAIN_STRINGS,
  matchLanguage,
  resolveMainLanguage,
  mainStrings,
};
