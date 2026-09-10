/**
 * @fileoverview Dependency-free browser localization and user-facing branding.
 *
 * English remains the canonical source language. The translator covers the static
 * application shell plus DOM content inserted later by the plain-JS UI modules.
 * It deliberately skips terminal/file/response/user-name surfaces so user content
 * is never mistaken for application copy. Missing entries fall back to English.
 *
 * @dependency none (loads after constants.js, before all UI modules)
 * @loadorder 1.5 of 16
 */

(function initCodemanI18n(global) {
  'use strict';

  const DEFAULT_NAME = 'Codeman';
  const SUPPORTED_LANGUAGES = new Set(['en', 'zh-CN']);
  const TRANSLATABLE_ATTRIBUTES = ['title', 'aria-label', 'placeholder'];
  const SKIP_SELECTOR = [
    '[data-i18n-skip]',
    '.xterm',
    '.terminal-container',
    '.terminal-output',
    '.response-content',
    '.response-viewer-content',
    '.file-preview-content',
    '.session-tab-name',
    '.session-name',
    '.case-name',
    '.notif-item-message',
    'pre',
    'code',
    'script',
    'style',
    'textarea',
  ].join(',');
  const USER_TEXT_SELECTOR = [
    '.history-item-title',
    '.history-item-summary',
    '.history-item-subtitle',
    '.history-detail-prompt',
    '.history-detail-path',
    '.folder-history-subtitle',
  ].join(',');

  // Exact English-source translations. Technical names, command examples, model
  // names, keyboard chords, and user-authored content intentionally stay unchanged.
  const ZH_CN = Object.freeze({
    'Skip to terminal': '跳转到终端',
    'Go to main page': '返回主页',
    'Session tabs': '会话标签页',
    /* 'Sessions' (the sidebar heading) is already mapped further down. */
    'Collapse session sidebar': '收起会话侧边栏',
    'Expand session sidebar': '展开会话侧边栏',
    'Filter sessions': '筛选会话',
    'Admin Panel': '管理面板',
    'Open admin panel': '打开管理面板',
    'Re-dock to dashboard (close window)': '重新停靠到主界面（关闭窗口）',
    'Tunnel status': '隧道状态',
    'Decrease font size': '减小字体',
    'Increase font size': '增大字体',
    'Current font size': '当前字体大小',
    'System resource usage': '系统资源使用情况',
    'Redraw terminal': '重绘终端',
    'Redraw terminal to fit current screen (Ctrl+Shift+R)': '重绘终端以适应当前屏幕（Ctrl+Shift+R）',
    'View last response': '查看最近一次回复',
    'Away Digest': '离开期间摘要',
    'Open away digest': '打开离开期间摘要',
    'Session Manager': '会话管理器',
    'Session actions': '会话操作',
    'Open session manager': '打开会话管理器',
    Attachments: '附件',
    'Open attachment history': '打开附件历史',
    'File Viewer': '文件查看器',
    'Open file viewer': '打开文件查看器',
    'Open Codeman across all displays': '在所有显示器上打开 {name}',
    'Ultracode / Workflow agents': 'Ultracode / Workflow 智能体',
    'Open ultracode workflow agents': '打开 Ultracode 工作流智能体',
    Notifications: '通知',
    'Toggle notifications': '切换通知面板',
    'Session Lifecycle Log': '会话生命周期日志',
    'Open session lifecycle log': '打开会话生命周期日志',
    'App Settings': '应用设置',
    'Open app settings': '打开应用设置',
    'Total tokens across all sessions': '所有会话的 Token 总数',
    'Token usage across active sessions': '活动会话的 Token 使用量',
    'Instance count': '实例数量',
    'No response yet': '暂无回复',
    'No response yet — send a message in this session first.': '暂无回复，请先在此会话中发送一条消息。',
    'No full conversation history available for this session': '此会话没有可显示的完整对话历史',
    'Last Response': '最近一次回复',
    More: '更多',
    'Codeman version': '{name}版本',
    Stop: '停止',
    Watching: '监视中',
    Orchestrator: '编排器',
    Close: '关闭',
    'Close window': '关闭窗口',
    'Session unavailable': '会话不可用',
    'This session has ended or is no longer available.': '此会话已结束或不再可用。',

    // Welcome / quick start / common actions
    'Manage AI Coding tools in persistent tmux sessions.': '在持久化 tmux 会话中管理 AI 编程工具。',
    'Select case': '选择案例',
    'Select Case': '选择案例',
    'All cases': '全部案例',
    'No directory': '未选择目录',
    Run: '运行',
    'Run Claude Code': '运行 Claude Code',
    'Run OpenCode': '运行 OpenCode',
    'Run Gemini': '运行 Gemini',
    'Run Antigravity': '运行 Antigravity',
    'Run Pi': '运行 Pi',
    'Run Grok': '运行 Grok',
    'Run DeepSeek': '运行 DeepSeek',
    'Run Shell': '运行 Shell',
    'Select AI backend': '选择 AI 后端',
    'Create New Case': '新建案例',
    'Create new case': '新建案例',
    'Link Existing': '关联现有目录',
    'Add Case': '添加案例',
    'Open sessions': '打开会话',
    'Recent Sessions': '最近会话',
    'Search sessions by name, prompt, or path…': '按名称、提示词或路径搜索会话…',
    'Search open sessions or start a new one': '搜索已打开会话或启动新会话',
    'Find Open Session': '查找已打开会话',
    'No background agents': '没有后台智能体',
    'No background agents detected': '未检测到后台智能体',
    'No notifications': '没有通知',
    'No mux sessions': '没有 mux 会话',
    'No lifecycle entries found': '未找到生命周期记录',
    'No ultracode runs detected': '未检测到 Ultracode 运行',

    // Global/common controls
    Display: '显示',
    'Claude CLI': 'Claude CLI',
    'Codex CLI': 'Codex CLI',
    Models: '模型',
    Shortcuts: '快捷键',
    Voice: '语音',
    Save: '保存',
    Cancel: '取消',
    Apply: '应用',
    Create: '创建',
    Add: '添加',
    Delete: '删除',
    Remove: '移除',
    Edit: '编辑',
    Refresh: '刷新',
    Back: '返回',
    Next: '下一步',
    Previous: '上一步',
    Clear: '清除',
    'Clear all': '全部清除',
    'Clear All': '全部清除',
    Search: '搜索',
    Filter: '筛选',
    Enable: '启用',
    Enabled: '已启用',
    Disabled: '已禁用',
    Active: '活动',
    'Not active': '未活动',
    On: '开',
    Off: '关',
    Yes: '是',
    No: '否',
    Optional: '可选',
    Default: '默认',
    Custom: '自定义',
    Name: '名称',
    Description: '描述',
    Status: '状态',
    Reason: '原因',
    Time: '时间',
    Event: '事件',
    Events: '事件',
    Session: '会话',
    Sessions: '会话',
    Files: '文件',
    History: '历史',
    Summary: '摘要',
    Details: '详情',
    Options: '选项',
    Settings: '设置',
    Help: '帮助',
    Loading: '正在加载',
    Error: '错误',
    Errors: '错误',
    Warning: '警告',
    Warnings: '警告',
    Info: '信息',
    Complete: '完成',
    Completed: '已完成',
    Stopped: '已停止',
    Running: '运行中',
    Idle: '空闲',
    Working: '工作中',
    Today: '今天',
    Home: '主页',
    Local: '本地',
    Remote: '远程',
    Docker: 'Docker',
    Terminal: '终端',
    Prompt: '提示词',
    Source: '来源',
    Type: '类型',
    Language: '语言',

    // Display settings
    'Branding & Language': '品牌与语言',
    'Display Name': '显示名称',
    'Interface Language': '界面语言',
    'Name shown in the browser UI and window title. Supports Unicode, including Chinese.':
      '显示在浏览器界面和窗口标题中的名称。支持 Unicode，包括中文。',
    'Language for this device. Dynamic status messages and dialogs use the same language.':
      '此设备使用的界面语言。动态状态消息与对话框也会使用同一语言。',
    English: 'English',
    Appearance: '外观',
    Skin: '皮肤',
    'Visual theme for this device (not synced)': '此设备的视觉主题（不同步）',
    'Daylight Blue': '日光蓝',
    'Daylight Green': '日光绿',
    'OG Codeman': '经典 {name}',
    Performance: '性能',
    'WebGL Renderer': 'WebGL 渲染器',
    'Header Displays': '顶部栏显示',
    'Font Controls': '字体控制',
    'System Stats': '系统状态',
    'Lifecycle Log': '生命周期日志',
    'Response Viewer': '回复查看器',
    'Attachments Button': '附件按钮',
    'Multi-monitor Button': '多显示器按钮',
    'Session Manager Button': '会话管理器按钮',
    'Away Digest Button': '离开期间摘要按钮',
    'Cron Button': '定时任务按钮',
    'Redraw Terminal Button': '重绘终端按钮',
    'Tab Bar': '标签栏',
    'Session List Layout': '会话列表布局',
    'Session Name Font Size': '会话名称字体大小',
    'Adjust only session names in the vertical sidebar.': '仅调整垂直侧边栏中的会话名称。',
    'Header tab strip': '顶栏标签条',
    'Left sidebar': '左侧边栏',
    'Left sidebar simple': '左侧边栏（简洁）',
    'Horizontal strip in the header, or a collapsible left sidebar (Alt+B). The rich sidebar carries the same per-session detail as the home screen.':
      '会话列表显示为顶栏横向标签条，或左侧可折叠侧边栏（Alt+B）。完整侧边栏为每个会话显示与主界面相同的详细信息。',
    'Tall Tabs (Name + Folder)': '双行标签（名称 + 文件夹）',
    'Pop-out Button on Tabs': '标签页弹出窗口按钮',
    Panels: '面板',
    Monitor: '监视器',
    'Project Insights': '项目洞察',
    'File Browser': '文件浏览器',
    Subagents: '子智能体',
    'Ultracode Agents': 'Ultracode 智能体',
    'Ultracode Floating Windows': 'Ultracode 浮动窗口',
    'Approvals Inbox': '审批收件箱',
    'Auto-name Sessions': '自动命名会话',
    Approvals: '审批',
    'Prompts waiting on you, across all sessions': '所有会话中等待您处理的提示',
    'No pending approvals': '没有待处理的审批',
    'Approvals waiting on you': '等待您审批的请求',
    'Open approvals inbox': '打开审批收件箱',
    'Close approvals inbox': '关闭审批收件箱',
    Approve: '批准',
    'Deny (Esc)': '拒绝 (Esc)',
    Deny: '拒绝',
    'Open session': '打开会话',
    Dismiss: '忽略',
    Send: '发送',
    Permission: '权限',
    Question: '问题',
    Idle: '空闲',
    'Read My Mind': '读心术',
    'Read My Mind: predict your next prompt': '读心术：预测您的下一条提示',
    'Predict my next prompt': '预测我的下一条提示',
    'Reading your mind…': '正在读取您的想法…',
    'No suggestion this time. Add a steer note and Rethink to try again.':
      '这次没有建议。可添加引导备注后点击「重想」再试一次。',
    Rethink: '重想',
    Insert: '插入',
    "Put the text on the session's composer without submitting it": '将文本放入会话输入框但不提交',
    'Predicted prompt, editable': '预测的提示，可编辑',
    'Use this suggestion instead': '改用此建议',
    "Steer the rethink, e.g. 'no, I meant the mobile bug'": '引导重想，例如："不，我是指移动端的问题"',
    'Steer note for Rethink': '重想的引导备注',
    'Select a session first': '请先选择一个会话',
    'Read My Mind works on Claude sessions only': '读心术仅适用于 Claude 会话',
    'Prompt sent': '提示已发送',
    'Inserted, press Enter in the terminal to send': '已插入，在终端中按 Enter 发送',
    'Could not reach the session': '无法连接到会话',
    'Subagent Options': '子智能体选项',
    'Enable Tracking': '启用跟踪',
    'Active Tab Only': '仅活动标签页',
    'Image Watcher': '图像监视器',
    'Enable Globally': '全局启用',
    'Remote Access': '远程访问',
    'Cloudflare Tunnel': 'Cloudflare 隧道',
    'Tunnel URL': '隧道地址',
    'Upload URL': '上传地址',
    Updates: '更新',
    'Current Version': '当前版本',
    'Check for Updates': '检查更新',
    'Check now': '立即检查',
    'Update available': '有可用更新',
    'Update now': '立即更新',
    'Show CPU and memory usage in header': '在顶部栏显示 CPU 与内存使用情况',
    'Show session lifecycle log button in header': '在顶部栏显示会话生命周期日志按钮',
    'Show the response viewer (eye) button in header': '在顶部栏显示回复查看器（眼睛）按钮',
    'Show the file viewer button in header (opens the file browser panel for the active session)':
      '在顶部栏显示文件查看器按钮（打开当前会话的文件浏览器面板）',
    'Show the attachments button in header (opens the attachment history drawer)':
      '在顶部栏显示附件按钮（打开附件历史抽屉）',
    'Show the multi-monitor button in the header (opens Codeman spanned across all displays)':
      '在顶部栏显示多显示器按钮（跨所有显示器打开 {name}）',
    'Show the session manager button in the header (opens the session manager — sessions also stay reachable via the Ctrl+K palette)':
      '在顶部栏显示会话管理器按钮（也可通过 Ctrl+K 面板访问会话）',
    "Show the away digest button in the header (opens the 'what happened while you were away' summary)":
      '在顶部栏显示离开期间摘要按钮',
    'Show the Cron button in the footer toolbar (opens the cron jobs manager)': '在底部工具栏显示定时任务按钮',
    'Show a terminal redraw button in the header — refit the terminal to the current screen size (useful when switching between devices)':
      '在顶部栏显示终端重绘按钮，以重新适配当前屏幕大小',
    'Show folder path below tab name and allow tab bar to wrap into multiple rows':
      '在标签名称下显示文件夹路径，并允许标签栏换行',
    'Show Monitor panel at bottom right': '在右下角显示监视器面板',
    'Show active tools and file viewers in a floating panel': '在浮动面板中显示活动工具与文件查看器',
    'Show file browser panel on the right side': '在右侧显示文件浏览器面板',
    'Show the Subagents panel (independent from Monitor)': '显示子智能体面板（独立于监视器）',
    'Monitor Claude Code background agents in real-time': '实时监视 Claude Code 后台智能体',
    'Only show subagent windows when their parent tab is selected': '仅在选中父标签页时显示子智能体窗口',
    'Automatically detect and popup new images in session directories': '自动检测并弹出会话目录中的新图像',
    'Expose Codeman via Cloudflare Tunnel for remote access': '通过 Cloudflare 隧道远程访问 {name}',
    'Codeman version currently running': '当前运行的{name}版本',
    'Check GitHub for a newer Codeman release': '检查 GitHub 上是否有新版 {name}',

    // Input settings
    Input: '输入',
    Font: '字体',
    'Terminal font': '终端字体',
    'Prepended to the built-in stack, so fallbacks (including bundled Nerd Font symbols) keep working. Must be installed on this device. Leave empty for the default.':
      '置于内置字体栈之前，回退字体（包括内置的 Nerd Font 图标）仍然生效。需已安装在本设备上。留空使用默认值。',
    'Normal font weight': '常规字重',
    'Weight for ordinary terminal text. Lowering it widens the step up to bold, which for a family shipping only a regular and a bold face is the only cue bold text carries. Needs a family with faces at that weight; the bundled font covers 100 to 800.':
      '终端普通文本的字重。调低可拉大与粗体之间的差距；对于只提供常规和粗体两种字形的字体，这一差距是粗体文本唯一的视觉提示。需要字体具备该字重的字形，内置字体覆盖 100 至 800。',
    'Bold font weight': '粗体字重',
    'Weight for bold terminal text. Only useful with a family carrying something heavier than its bold face.':
      '终端粗体文本的字重。仅当字体提供比其粗体更重的字形时才有意义。',
    'Local Echo': '本地回显',
    'CJK Input': '中日韩输入',
    'Extended Keyboard Bar': '扩展键盘栏',
    'Gesture Control (beta)': '手势控制（测试版）',
    'Wheel Scrolls Local History': '滚轮滚动本地历史',
    'Auto Copy Selection': '自动复制选中内容',
    'Selection & clipboard': '选中与剪贴板',
    'Auto Copy: selection copied': '自动复制：已复制选中内容',
    'Auto Copy failed: the browser blocked clipboard access': '自动复制失败：浏览器阻止了剪贴板访问',
    'Selection too large to copy automatically. Press Ctrl+C.': '选中内容过大，无法自动复制。请按 Ctrl+C。',
    'Instant typing feedback with local echo': '通过本地回显即时显示输入',
    'Dedicated IME input field for CJK languages': '为中日韩语言提供专用输入法文本框',
    'Extra keys: Tab, Esc, arrows, Ctrl+O': '附加按键：Tab、Esc、方向键、Ctrl+O',

    // CLI / model settings
    'Startup Mode': '启动模式',
    'Skip Permissions (default)': '跳过权限确认（默认）',
    'Auto (classifier-guarded, low prompts)': '自动（分类器保护，较少提示）',
    'Normal (with prompts)': '普通（显示提示）',
    'Allowed Tools Only': '仅允许指定工具',
    'Allowed Tools': '允许的工具',
    'Comma-separated list of tools to allow': '以逗号分隔允许使用的工具',
    'Enable Ralph / Todo Tracker': '启用 Ralph / 待办跟踪器',
    'Claude Permissions': 'Claude 权限',
    'Agent Teams': '智能体团队',
    'Claude Model': 'Claude 模型',
    '1M Opus Context': 'Opus 100 万上下文',
    'Remote auto-reconnect': '远程自动重连',
    'Thinking Effort': '思考强度',
    Low: '低',
    Medium: '中',
    High: '高',
    Max: '最高',
    'Nice Priority': 'Nice 优先级',
    'Enable Nice Priority Reduction': '启用 Nice 优先级调整',
    'Nice Value': 'Nice 值',
    'Bypass Approvals and Sandbox': '绕过审批与沙箱',
    'Default Model': '默认模型',
    'Show Optimizer Recommendations': '显示优化器建议',
    'Agent Type Overrides': '按智能体类型覆盖',
    'Use Default': '使用默认值',

    // Notifications / voice / shortcuts
    'Enable Notifications': '启用通知',
    'Master toggle for all notification layers': '所有通知层的总开关',
    'Browser Notifications': '浏览器通知',
    'Audio Alerts': '声音提醒',
    'Push Notifications': '推送通知',
    'Notification Levels': '通知级别',
    Critical: '严重',
    'Per-Event Settings': '按事件设置',
    'Permission prompts': '权限提示',
    'Questions from Claude': 'Claude 提问',
    'Session idle': '会话空闲',
    'Response complete': '回复完成',
    'Respawn cycles': '重生循环',
    'Task complete': '任务完成',
    'Subagent activity': '子智能体活动',
    Browser: '浏览器',
    Audio: '声音',
    Push: '推送',
    'Voice Input': '语音输入',
    Provider: '服务商',
    'Active Provider': '当前服务商',
    'API Key': 'API 密钥',
    'Domain Keywords': '领域关键词',
    'Input Mode': '输入模式',
    'Direct to input': '直接输入',
    'Compose dialog': '编辑对话框',
    'Keyboard Shortcuts': '键盘快捷键',
    'Customize keyboard shortcuts. Click the binding to capture a new key combination.':
      '自定义键盘快捷键。点击按键组合即可录入新的组合。',
    'Show Shortcuts': '显示快捷键',
    'Full shortcut reference': '完整快捷键参考',

    // Mobile overview (phone home screen)
    'Needs you': '需要你',
    'Current sessions': '当前会话',
    'Past sessions': '历史会话',
    'Show all past sessions': '显示全部历史会话',
    'Show fewer': '收起',
    'Choose what to run': '选择运行方式',
    'Web / URL': '网页 / 链接',
    'Add URL…': '添加链接…',
    'Nothing running. Hit Run to start something.': '当前没有运行中的会话。点击“运行”开始。',
    'No past conversations yet': '尚无历史对话',
    'Loading…': '加载中…',
    // Status pills are deliberately NOT listed: they are single generic words
    // ("idle", "done", "error") that also appear as state strings elsewhere, so
    // they carry data-i18n-skip in the DOM instead of a translation entry here.
    'Overview Home Screen': '概览主页',
    'On phones, the C logo opens a session overview (needs you / spaces / idle) instead of the welcome screen':
      '在手机上，点击 C 图标打开会话概览（需要你 / 空间 / 空闲），而不是欢迎页',
    Phone: '手机',

    // Desktop home screen tab column (home-sessions.js)
    'Open tabs': '打开的标签',

    // Session/case dialogs
    'Session Options': '会话选项',
    'Session Name': '会话名称',
    'Session Color': '会话颜色',
    'Working Directory': '工作目录',
    'Set working directory': '设置工作目录',
    'Resume Conversation': '继续对话',
    'Close Session': '关闭会话',
    'Choose how to close': '选择关闭方式',
    'Tmux session keeps running in background': 'Tmux 会话继续在后台运行',
    'Terminate the session completely': '彻底终止会话',
    'Cancel close session': '取消关闭会话',
    'Case Name': '案例名称',
    'Folder Path': '文件夹路径',
    'Default Working Directory': '默认工作目录',
    'Default directory for new sessions.': '新会话的默认目录。',
    'Default CLAUDE.md Template': '默认 CLAUDE.md 模板',
    'Used when creating new cases. Leave empty for built-in template.': '创建新案例时使用；留空则使用内置模板。',
    'Remote Path': '远程路径',
    'SSH Host/IP': 'SSH 主机/IP',
    'SSH Username': 'SSH 用户名',
    'SSH Port': 'SSH 端口',
    'Identity File': '身份文件',
    'Jump Host': '跳板主机',
    'Advanced SSH': '高级 SSH',
    'Discover existing sessions': '发现现有会话',
    'Workspace Path': '工作区路径',
    'Container settings (optional, sensible defaults)': '容器设置（可选，默认值合理）',
    Template: '模板',
    Network: '网络',
    CPUs: 'CPU 数',
    Memory: '内存',
    GPUs: 'GPU',

    // Cron / lifecycle / panels
    'Cron Jobs': '定时任务',
    '+ New Job': '+ 新建任务',
    'New Cron Job': '新建定时任务',
    Schedule: '计划',
    'Schedule Type': '计划类型',
    Once: '一次',
    Interval: '间隔',
    Daily: '每天',
    Weekly: '每周',
    'Run At': '运行时间',
    'Every (minutes)': '每隔（分钟）',
    Weekdays: '工作日',
    "Times use the server's local timezone.": '时间使用服务器本地时区。',
    'All Events': '全部事件',
    Created: '已创建',
    Started: '已启动',
    Exit: '退出',
    Deleted: '已删除',
    Recovered: '已恢复',
    'Stale Cleaned': '已清理过期项',
    'Mux Died': 'Mux 已终止',
    'Server Started': '服务器已启动',
    'Server Stopped': '服务器已停止',
    Extra: '附加信息',
    'Token Usage Statistics': 'Token 使用统计',
    'Daily Breakdown': '每日明细',
    'Export JSON': '导出 JSON',
    'Export MD': '导出 Markdown',

    // Dynamic common status / toasts
    'Settings saved': '设置已保存',
    'Settings saved locally': '设置已保存到本机',
    'Tunnel active': '隧道已启用',
    'Tunnel starting — QR code will appear when ready...': '隧道正在启动，准备好后将显示二维码…',
    'Push notifications enabled': '推送通知已启用',
    'Push notifications disabled': '推送通知已禁用',
    'Permission Required': '需要授权',
    'Waiting for Input': '等待输入',
    'Question Asked': 'Claude 正在提问',
    'Response Complete': '回复完成',
    'Task Completed': '任务已完成',
    'Teammate Idle': '队友空闲',
    'Session Error': '会话错误',
    'Respawn Blocked': '重生已阻止',
    'Task Complete': '任务完成',
    'Copied to clipboard': '已复制到剪贴板',
    // Terminal touch-selection bar (long-press to select). The bar is a sibling of
    // `.xterm`, not a descendant, so SKIP_SELECTOR does not cover it and these apply.
    Copy: '复制',
    Line: '整行',
    'Clear selection': '清除选择',
    'Failed to copy': '复制失败',
    'Checking…': '正在检查…',
    'Starting…': '正在启动…',
    'Starting update…': '正在开始更新…',
    'Queued…': '已排队…',
    'Preparing…': '正在准备…',
    'Stashing local changes…': '正在暂存本地更改…',
    'Fetching release…': '正在获取发行版…',
    'Checking out release…': '正在检出发行版…',
    'Installing dependencies…': '正在安装依赖…',
    'Building…': '正在构建…',
    'Restarting Codeman…': '正在重启 {name}…',
    'Try again': '重试',
    'Could not check for updates. Try again later.': '无法检查更新，请稍后重试。',
    'The previous version is still running.': '先前版本仍在运行。',

    // Remaining settings, wizard, case and management surfaces
    'Advanced Options': '高级选项',
    'Advanced container settings': '高级容器设置',
    Basics: '基本设置',
    Behavior: '行为',
    Alerts: '提醒',
    Limits: '限制',
    Paths: '路径',
    Notes: '备注',
    Context: '上下文',
    Duration: '持续时间',
    Iterations: '迭代次数',
    Elapsed: '已用时间',
    Launch: '启动',
    'Launch Command': '启动命令',
    'Background Agents': '后台智能体',
    'Background Tasks': '后台任务',
    Tasks: '任务',
    'Explore Tasks': '探索任务',
    'Implement Tasks': '实现任务',
    'Test Tasks': '测试任务',
    'Review Tasks': '审查任务',
    'Agent Type': '智能体类型',
    'Implementation Plan': '实施计划',
    Plan: '计划',
    'Plan:': '计划：',
    'Plan Usage Limits': '套餐使用限制',
    'Plan Wizard Agents': '计划向导智能体',
    'Fix Plan Menu': '修复计划菜单',
    'View Fix Plan': '查看修复计划',
    'Regenerate Plan': '重新生成计划',
    'Cancel plan generation': '取消生成计划',
    'Describe your task below. Claude will generate an implementation plan with testing steps.':
      '请在下方描述任务，Claude 将生成包含测试步骤的实施计划。',
    'What do you want to build?': '你想构建什么？',
    'A brief description...': '简要描述…',
    Describe: '描述',
    Enhanced: '增强',
    'Enhanced: parallel subagents + verification (slower but more thorough)':
      '增强：并行子智能体 + 验证（速度较慢，但更全面）',
    Standard: '标准',
    'Single-pass generation with Opus 4.5': '使用 Opus 4.5 单轮生成',
    'Initializing deep reasoning model': '正在初始化深度推理模型',
    'Starting Opus 4.5...': '正在启动 Opus 4.5…',
    'Auto-launch when plan completes': '计划完成后自动启动',
    'Auto-accept prompts': '自动接受提示',
    'Presses Enter for plan approvals and default question options': '对计划审批和默认问题选项自动按 Enter',
    'Auto-accepts, auto-clears, agent completions': '自动接受、自动清理和智能体完成提醒',
    'Or click Run to start': '或点击“运行”开始',
    'to edit your task, or': '以编辑任务，或',
    'to continue without a plan': '以不使用计划直接继续',

    // Ralph / respawn
    Respawn: '重生',
    'Respawn loop': '重生循环',
    'Enable Respawn': '启用重生',
    'Stop Respawn': '停止重生',
    'Auto-resume when usage limit resets': '使用限制重置后自动继续',
    'Auto-restart sessions when context fills up (usually not needed)': '上下文已满时自动重启会话（通常不需要）',
    'Auto-Compact': '自动压缩',
    'Auto-Clear': '自动清空',
    'Token Management': 'Token 管理',
    'Use 1M token context window': '使用 100 万 Token 上下文窗口',
    'Use 1M token context window for new sessions': '新会话使用 100 万 Token 上下文窗口',
    'Full context reset at threshold (use higher than compact)': '达到阈值时完全重置上下文（阈值应高于压缩阈值）',
    'Idle Threshold': '空闲阈值',
    'Max Iterations': '最大迭代次数',
    'Max Iterations:': '最大迭代次数：',
    'Max Todos': '最大待办数',
    'Todo Expiration': '待办过期时间',
    'Completion Phrase': '完成短语',
    'Completion Phrase:': '完成短语：',
    'Phrase Claude outputs when loop is complete (without <promise> tags)':
      '循环完成时 Claude 输出的短语（不含 <promise> 标签）',
    'Prompt to send when idle': '空闲时发送的提示词',
    'Prompt to send into the session': '发送到会话的提示词',
    'Prompt Source': '提示词来源',
    'Prompt File Path': '提示词文件路径',
    'Prompt file path': '提示词文件路径',
    'Prompt Preview': '提示词预览',
    'Load Preset': '加载预设',
    Presets: '预设',
    'Apply preset': '应用预设',
    'Save Preset': '保存预设',
    'Save Respawn Preset': '保存重生预设',
    'Save current config as preset': '将当前配置保存为预设',
    'Preset Name': '预设名称',
    'Description (optional)': '描述（可选）',
    'When to use this preset': '此预设的适用场景',
    'Start Loop': '启动循环',
    'Start Ralph Loop': '启动 Ralph 循环',
    'Start Ralph Loop →': '启动 Ralph 循环 →',
    'Enable Tracker': '启用跟踪器',
    'Ralph / Todo': 'Ralph / 待办',
    'Ralph / Todo Tracker': 'Ralph / 待办跟踪器',
    'Cycle Steps': '循环步骤',
    '1. Update Prompt': '1. 更新提示词',
    '2. Send /clear': '2. 发送 /clear',
    '3. Send /init': '3. 发送 /init',
    '4. Kickstart Prompt': '4. 启动提示词',
    'Sent only when /init completes but Claude stays idle · Auto-accept presses Enter for plan approvals and default options':
      '仅在 /init 完成后 Claude 仍空闲时发送；自动接受会对计划审批和默认选项按 Enter',
    'One autonomous work cycle: whenever Claude goes idle, Codeman sends the update prompt, optionally runs /clear + /init, and kickstarts the next round — repeating for the chosen duration. All settings below belong to this loop; configure them, then press Enable.':
      '一个自主工作循环：Claude 每次空闲时，{name}都会发送更新提示词，可选执行 /clear + /init，并启动下一轮，持续到设定时长。下方设置均属于此循环；配置后点击“启用”。',
    'If Claude pauses on a usage limit ("limit reached · resets 3pm"), Codeman waits for the reset time and automatically continues the work. Independent of the respawn loop below.':
      '如果 Claude 因使用限制暂停（“limit reached · resets 3pm”），{name}会等待限制重置并自动继续工作。此功能独立于下方的重生循环。',

    // Search, session and panel surfaces
    'Search sessions, events, files…': '搜索会话、事件和文件…',
    'Search across sessions': '跨会话搜索',
    'Filter by case': '按案例筛选',
    'Filter by date range': '按日期范围筛选',
    'Filter by session status': '按会话状态筛选',
    'Filter files...': '筛选文件…',
    'Any status': '任意状态',
    'Any time': '任意时间',
    'Last hour': '最近一小时',
    'Last 7 Days': '最近 7 天',
    'Past 24h': '过去 24 小时',
    'Past 7 days': '过去 7 天',
    'Past 30 days': '过去 30 天',
    'Since last visit': '自上次访问以来',
    Since: '开始时间',
    Until: '结束时间',
    'Away digest range': '离开期间摘要范围',
    'Open the digest to load recent activity': '打开摘要以加载最近活动',
    'Refresh away digest': '刷新离开期间摘要',
    'Refresh summary': '刷新摘要',
    'Select a session to view files': '选择会话以查看文件',
    'Select a session to view summary': '选择会话以查看摘要',
    'Select an agent to view details': '选择智能体以查看详情',
    'Select a run to view its agents': '选择一次运行以查看其智能体',
    'Source type filter': '来源类型筛选',
    'Copy content': '复制内容',
    'Edit file': '编辑文件',
    'Unsaved changes': '未保存的更改',
    Saved: '已保存',
    'Export as JSON': '导出为 JSON',
    'Export as Markdown': '导出为 Markdown',
    'Mark all read': '全部标为已读',
    'Clear search': '清除搜索',
    'Clear all tracked subagents': '清除所有已跟踪的子智能体',
    'Kill All Sessions': '终止所有会话',
    'Kill all sessions and their tmux processes': '终止所有会话及其 tmux 进程',
    'Kill All Claude + Tmux': '终止全部 Claude + Tmux',
    'Kill Tmux & Claude Code': '终止 Tmux 与 Claude Code',
    'Terminate everything completely': '彻底终止所有内容',
    'Tmux Sessions': 'Tmux 会话',
    'Tmux sessions keep running in background': 'Tmux 会话继续在后台运行',
    'Refresh tmux sessions': '刷新 Tmux 会话',
    'Restore Terminal Size': '恢复终端大小',
    'Clear Terminal': '清空终端',
    'Stop current run': '停止当前运行',
    'Stop respawn': '停止重生',
    'Stop (Ctrl+C)': '停止（Ctrl+C）',

    // Case, remote and Docker details
    Case: '案例',
    'Case:': '案例：',
    'Case settings': '案例设置',
    'Create New': '新建',
    'Auto (directory name)': '自动（目录名）',
    'Custom name shown in the tab (right-click tab to rename inline)':
      '标签页中显示的自定义名称（右键标签可直接重命名）',
    'Name to identify this case in Codeman': '用于在{name}中标识此案例的名称',
    'Name to identify this remote case in Codeman': '用于在{name}中标识此远程案例的名称',
    'Absolute path on the remote host. Codeman will not create or delete it.':
      '远程主机上的绝对路径；{name}不会创建或删除该目录。',
    'Absolute path to an existing project folder, e.g. /home/you/my-project':
      '现有项目文件夹的绝对路径，例如 /home/you/my-project',
    'Letters, numbers, hyphens, underscores only. Created in ~/codeman-cases/':
      '仅允许字母、数字、连字符和下划线；将在 ~/codeman-cases/ 中创建。',
    'Docker exports': 'Docker 导出',
    'No exports yet. Export a docker case from its tab.': '暂无导出；请从 Docker 案例标签页导出。',
    'Runs inside an isolated container. Multiple sessions can share the same container.':
      '在隔离容器内运行；多个会话可以共享同一容器。',
    'Runs this case in a hardened, isolated container. The base image is built automatically on first use. Docker/Podman must be installed.':
      '在加固的隔离容器中运行此案例。首次使用时会自动构建基础镜像；必须安装 Docker/Podman。',
    'Run in an isolated Docker container': '在隔离的 Docker 容器中运行',
    'Attach to an existing container': '接入已在运行的容器',
    'On: Codeman only runs docker exec into a container you already built and run — it never creates, starts, stops or removes it. The CLIs must already be installed and logged in inside it.':
      '开启后，{name}只会 docker exec 进入你自己构建并运行的容器，绝不创建、启动、停止或删除它；容器内必须已安装并登录好相应 CLI。',
    'Container Name': '容器名称',
    'Pick from the running containers or type a name.': '从正在运行的容器中选择，或直接输入名称。',
    'Check container': '检查容器',
    'Container Workdir': '容器内工作目录',
    'A path that already exists inside the container. Adoption mounts nothing, so this need not match the host workspace path.':
      '容器内已存在的路径。接入不挂载任何目录，因此它不必与主机工作区路径相同。',
    'Already have a container running?': '已经有正在运行的容器？',
    'Attach to it instead': '改为接入该容器',
    'Codeman only runs docker exec into it and never touches its lifecycle.':
      '{name}只会 docker exec 进入它，绝不触碰其生命周期。',
    'Absolute HOST directory, bind-mounted into the container. Codeman scaffolds CLAUDE.md + hooks into it.':
      '绑定挂载到容器中的主机绝对目录；{name}会在其中生成 CLAUDE.md 和 hooks。',
    'A reusable docker host profile. Reuse the same ID across cases to share settings.':
      '可复用的 Docker 主机配置；多个案例使用同一 ID 可共享设置。',
    'Mount host credentials (~/.claude etc.)': '挂载主机凭据（~/.claude 等）',
    'On: your existing login just works (creds stay on the host, never in exports). Off: sealed sandbox, log in inside the container.':
      '开启：直接使用现有登录（凭据保留在主机且不会进入导出）；关闭：使用密封沙箱，需要在容器内登录。',
    'Disk is elastic: storage grows automatically as data flows in (no fixed cap).':
      '磁盘为弹性容量：会随数据自动增长（无固定上限）。',
    'Needs the NVIDIA container toolkit on the host.': '主机需要安装 NVIDIA Container Toolkit。',
    'GPU — 8 GB RAM, 4 CPU, all GPUs': 'GPU — 8 GB 内存、4 CPU、全部 GPU',
    'Large — 8 GB RAM, 4 CPU': '大型 — 8 GB 内存、4 CPU',
    'Medium — 4 GB RAM, 2 CPU (default)': '中型 — 4 GB 内存、2 CPU（默认）',
    'Small — 2 GB RAM, 1 CPU': '小型 — 2 GB 内存、1 CPU',
    'bridge (internet on, default)': '桥接（可联网，默认）',
    'bridge (internet on)': '桥接（可联网）',
    'none (fully isolated, no network)': '无（完全隔离，不联网）',
    'none (fully isolated)': '无（完全隔离）',
    'Resume last conversation on relaunch': '重新启动时继续最近一次对话',
    'Extra -o Options': '附加 -o 选项',
    'SOCKS Proxy': 'SOCKS 代理',
    'Host ID': '主机 ID',
    'Optional. Leave blank for the default port 22.': '可选；留空使用默认端口 22。',
    'Optional. Path to a private key on this machine (passed to ssh -i). Never the key contents.':
      '可选；本机私钥文件路径（传给 ssh -i），请勿填写密钥内容。',
    'Optional. [user@]host[:port] for ssh -J (jump/bastion host).':
      '可选；ssh -J 使用的 [user@]host[:port]（跳板机）。',
    'Optional. One KEY=VALUE per line; each becomes an ssh -o option.':
      '可选；每行一个 KEY=VALUE，每项都会成为 ssh -o 选项。',

    // Settings descriptions and remaining common controls
    'Use the GPU-accelerated WebGL terminal renderer (desktop only). Turn off to force the DOM renderer if you hit GPU glitches. Codeman also auto-falls-back to the DOM renderer after repeated GPU stalls.':
      '使用 GPU 加速的 WebGL 终端渲染器（仅桌面端）。如遇 GPU 显示问题，可关闭以强制使用 DOM 渲染器；多次 GPU 卡顿后{name}也会自动回退。',
    'Show A-/A+ font size buttons in header': '在顶部栏显示 A-/A+ 字体大小按钮',
    'Show Claude plan usage limits (5-hour & weekly) in the header. Applies to newly created sessions.':
      '在顶部栏显示 Claude 套餐使用限制（5 小时和每周）；适用于新建会话。',
    'Show ultracode / Workflow runs as a master-detail tab (tasks on the left, agents with tokens + tool calls on the right)':
      '以主从标签页显示 Ultracode / Workflow 运行（左侧任务，右侧智能体 Token 与工具调用）',
    'Pop a floating window for each active ultracode / Workflow run, connected by a line to its session tab (additional to the Ultracode Agents panel)':
      '为每个活动的 Ultracode / Workflow 运行弹出浮动窗口，并用连线连接到其会话标签页',
    'Shows typed characters instantly via overlay while forwarding keystrokes to the server in the background. Enables Tab completion, preserves input across tab switches, and protects against session crashes. Recommended for mobile and high-latency connections.':
      '通过覆盖层即时显示输入，同时在后台把按键转发到服务器。支持 Tab 补全、切换标签时保留输入并防止会话崩溃丢字；推荐移动端和高延迟连接使用。',
    "Show a dedicated input field below the terminal for CJK (Chinese/Japanese/Korean) IME composition. Recommended for mobile devices with Chinese input methods where xterm's native input handling may drop characters.":
      '在终端下方显示中日韩输入法专用文本框。推荐在可能因 xterm 原生输入而丢字的移动端中文输入法中使用。',
    'Show additional buttons (Tab, Shift+Tab, Ctrl+O, Esc, Alt+Enter, left/right arrows) in the mobile keyboard accessory bar.':
      '在移动端键盘工具栏显示附加按键（Tab、Shift+Tab、Ctrl+O、Esc、Alt+Enter、左右方向键）。',
    'Scroll local history (when mouse passthrough is active)': '滚动本地历史（鼠标直通启用时）',
    'Plain wheel/trackpad pages the terminal scrollback': '使用普通滚轮/触控板翻阅终端历史',
    'Camera hand-tracking overlay (applied on reload)': '摄像头手势跟踪覆盖层（重新加载后生效）',
    'Enable the camera hand-tracking gesture overlay (applied on reload). The instance must run with CODEMAN_GESTURE=1.':
      '启用摄像头手势跟踪覆盖层（重新加载后生效）；实例必须以 CODEMAN_GESTURE=1 运行。',
    'How Claude CLI is started in screen sessions. Auto Mode runs without routine prompts behind a background safety classifier (needs Claude Code 2.1.207+ and Opus 4.6+/Sonnet 4.6+/Fable 5)':
      '设置 Claude CLI 在会话中的启动方式。自动模式由后台安全分类器保护，无需常规确认（需要 Claude Code 2.1.207+ 和 Opus 4.6+/Sonnet 4.6+/Fable 5）。',
    'Auto-enable for new sessions (otherwise auto-enables on Ralph pattern detection)':
      '为新会话自动启用（否则检测到 Ralph 模式时自动启用）',
    'Enable experimental Agent Teams for all new Claude sessions (disabled by default)':
      '为所有新 Claude 会话启用实验性智能体团队（默认关闭）',
    'Automatically re-establish remote (SSH) sessions when the connection drops, reattaching to the durable remote tmux session (on by default; bounded backoff)':
      '连接断开时自动重建远程 SSH 会话，并重新附加到持久化远程 tmux 会话（默认开启，有限退避）',
    'Default effort for new Claude sessions — soft default, switchable anytime in-session via /effort (e.g. /effort ultracode)':
      '新 Claude 会话的默认思考强度；这是软默认值，可随时在会话中通过 /effort 切换。',
    'Lower priority of Claude sessions (reduces system impact, only affects new sessions)':
      '降低 Claude 会话的进程优先级（减少系统影响，仅影响新会话）',
    'Process priority (-20 to 19, higher = lower priority, default: 10)':
      '进程优先级（-20 到 19；数值越大优先级越低；默认 10）',
    'Start new Codex sessions with --dangerously-bypass-approvals-and-sandbox':
      '使用 --dangerously-bypass-approvals-and-sandbox 启动新的 Codex 会话',
    'Model used for execution tasks. Optimizer suggestions are advisory only.':
      '执行任务使用的模型；优化器建议仅供参考。',
    "Show what the optimizer recommends (doesn't override your choice)": '显示优化器建议（不会覆盖你的选择）',
    'Optionally set specific models for each task type. Leave as "Use Default" to use your default model.':
      '可为每种任务类型指定模型；保留“使用默认值”即可使用默认模型。',
    'Request browser notification permission': '请求浏览器通知权限',
    'Show OS-level notifications when tab is hidden': '标签页隐藏时显示系统级通知',
    'OS-level push notifications — works even when tab is closed': '系统级推送通知，即使标签页关闭也可接收',
    'Play a short beep for critical events': '严重事件发生时播放短提示音',
    'Completions, budget warnings, stuck sessions': '完成提醒、预算警告和会话卡住提醒',
    'Errors, crashes, agent failures': '错误、崩溃和智能体失败',
    'Notify when a session is idle longer than this': '会话空闲超过此时长时通知',
    'Stored locally only, never sent to server. Get a key at': '仅存储在本机，绝不会发送到服务器。可在此获取密钥：',
    'Comma-separated terms to boost recognition accuracy': '以逗号分隔可提高识别准确率的术语',
    'Start voice input': '开始语音输入',
    'Voice input': '语音输入',
    'Voice input (Ctrl+Shift+V)': '语音输入（Ctrl+Shift+V）',
    'Insert Newline': '插入换行',
    'Close Panels': '关闭面板',
    'Previous / Next Session': '上一个 / 下一个会话',
    'Next Session': '下一个会话',
    'Switch to Tab N': '切换到第 N 个标签页',
    'Move Active Tab Left': '向左移动当前标签页',
    'Move Active Tab Right': '向右移动当前标签页',
    'Focus First Tab': '聚焦第一个标签页',
    'Focus Last Tab': '聚焦最后一个标签页',
    'Focus Next Tab': '聚焦下一个标签页',
    'Focus Previous Tab': '聚焦上一个标签页',
    'Activate Focused Tab': '激活聚焦的标签页',
    'Remove Tab': '移除标签页',
    'Remove All Tabs': '移除所有标签页',
    'Use arrows to reorder. Changes are saved automatically.': '使用方向键重新排序；更改会自动保存。',
  });

  const ZH_CN_LOWER = new Map(Object.entries(ZH_CN).map(([key, value]) => [key.toLocaleLowerCase('en'), value]));

  const textState = new WeakMap();
  const attributeState = new WeakMap();
  let language = normalizeLanguage(global.__codemanLanguage);
  let displayName = DEFAULT_NAME;
  let observer = null;
  let applying = false;

  function normalizeLanguage(value) {
    return SUPPORTED_LANGUAGES.has(value) ? value : 'en';
  }

  function normalizeDisplayName(value) {
    if (typeof value !== 'string') return DEFAULT_NAME;
    const normalized = value
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim();
    return normalized ? Array.from(normalized).slice(0, 40).join('') : DEFAULT_NAME;
  }

  function interpolate(value, variables) {
    return value.replace(/\{([a-zA-Z][\w]*)\}/g, (_match, key) => String(variables[key] ?? ''));
  }

  function translateDynamic(source) {
    const patterns = [
      [/^(\d+) tokens?$/, (_m, count) => `${count} 个 Token`],
      [/^(\d+) sessions?$/, (_m, count) => `${count} 个会话`],
      [/^(\d+) tasks?$/, (_m, count) => `${count} 个任务`],
      [/^(\d+) running$/, (_m, count) => `${count} 个运行中`],
      [/^(\d+) active$/, (_m, count) => `${count} 个活动`],
      [/^Show (\d+) more$/, (_m, count) => `再显示 ${count} 项`],
      [/^Show (\d+) more \((\d+) remaining\)$/, (_m, count, remaining) => `再显示 ${count} 项（剩余 ${remaining} 项）`],
      [/^Lifetime: (\d+) sessions created$/, (_m, count) => `累计已创建 ${count} 个会话`],
      [/^Tunnel active: (.+)$/, (_m, url) => `隧道已启用：${url}`],
      [/^Tunnel error: (.+)$/, (_m, error) => `隧道错误：${error}`],
      [/^Update to v(.+)$/, (_m, version) => `更新到 v${version}`],
      [/^You're up to date \(v(.+)\)\.$/, (_m, version) => `已是最新版本（v${version}）。`],
      [/^Update available: v(.+)$/, (_m, version) => `有可用更新：v${version}`],
      [/^Selected: (.+)$/, (_m, value) => `已选择：${value}`],
      [/^Failed to (.+)$/, (_m, action) => `操作失败：${action}`],
    ];
    for (const [pattern, replacement] of patterns) {
      const match = source.match(pattern);
      if (match) return replacement(...match);
    }
    const actionMatch = source.match(
      /^(Open|Close|Show|Hide|Enable|Disable|Start|Stop|Refresh|Save|Cancel|Clear|Select|View|Export|Import|Remove|Kill|Toggle|Increase|Decrease) (.+)$/i
    );
    if (actionMatch) {
      const action = {
        open: '打开',
        close: '关闭',
        show: '显示',
        hide: '隐藏',
        enable: '启用',
        disable: '禁用',
        start: '启动',
        stop: '停止',
        refresh: '刷新',
        save: '保存',
        cancel: '取消',
        clear: '清除',
        select: '选择',
        view: '查看',
        export: '导出',
        import: '导入',
        remove: '移除',
        kill: '终止',
        toggle: '切换',
        increase: '增大',
        decrease: '减小',
      }[actionMatch[1].toLowerCase()];
      const object = ZH_CN[actionMatch[2]] || ZH_CN_LOWER.get(actionMatch[2].toLocaleLowerCase('en'));
      if (action && object) return `${action}${object}`;
    }
    return null;
  }

  function brand(source) {
    if (!source || displayName === DEFAULT_NAME) return source;
    return source.replace(/Codeman/g, displayName).replace(/codeman(?=:)/g, displayName);
  }

  function t(source, variables = {}) {
    if (typeof source !== 'string' || !source) return source;
    const vars = { name: displayName, ...variables };
    if (language === 'zh-CN') {
      const translated = ZH_CN[source] || ZH_CN_LOWER.get(source.toLocaleLowerCase('en')) || translateDynamic(source);
      if (translated) return brand(interpolate(translated, vars));
    }
    return brand(interpolate(source, vars));
  }

  function shouldSkip(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !element || Boolean(element.closest(SKIP_SELECTOR));
  }

  function shouldSkipText(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return shouldSkip(node) || Boolean(element?.closest(USER_TEXT_SELECTOR));
  }

  function preserveWhitespace(source, translated) {
    const leading = source.match(/^\s*/)?.[0] || '';
    const trailing = source.match(/\s*$/)?.[0] || '';
    return leading + translated + trailing;
  }

  function translateTextNode(node) {
    let state = textState.get(node);
    if (shouldSkipText(node) || (!state && !/[A-Za-z]/.test(node.nodeValue || ''))) return;
    if (!state || node.nodeValue !== state.applied) {
      state = { source: node.nodeValue, applied: node.nodeValue };
    }
    const trimmed = state.source.trim();
    if (!trimmed) return;
    const next = preserveWhitespace(state.source, t(trimmed));
    state.applied = next;
    textState.set(node, state);
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function translateAttributes(element) {
    if (shouldSkip(element) || element.matches('.history-item[title]')) return;
    let states = attributeState.get(element);
    if (!states) states = new Map();
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute) || '';
      let state = states.get(attribute);
      if (!state || current !== state.applied) state = { source: current, applied: current };
      const next = t(state.source);
      state.applied = next;
      states.set(attribute, state);
      if (current !== next) element.setAttribute(attribute, next);
    }
    attributeState.set(element, states);
  }

  function translateNode(root) {
    if (!root || applying) return;
    applying = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) {
        translateTextNode(root);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
      if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
        else translateAttributes(node);
      }
    } finally {
      applying = false;
    }
  }

  function refreshDocumentTitle() {
    const current = document.title || '';
    const titleState = document.documentElement.dataset.i18nTitleSource || current;
    document.documentElement.dataset.i18nTitleSource = titleState;
    document.title = brand(titleState);
  }

  function configure(options = {}) {
    const previousDisplayName = displayName;
    language = normalizeLanguage(options.language ?? language);
    displayName = normalizeDisplayName(options.displayName ?? displayName);
    global.__codemanLanguage = language;
    global.__codemanDisplayName = displayName;
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
    if (previousDisplayName !== displayName) {
      const source = document.documentElement.dataset.i18nTitleSource || document.title || '';
      if (previousDisplayName !== DEFAULT_NAME && source.includes(previousDisplayName)) {
        document.documentElement.dataset.i18nTitleSource = source.replaceAll(previousDisplayName, displayName);
      }
    }
    translateNode(document.body);
    refreshDocumentTitle();
    return { language, displayName };
  }

  function start() {
    translateNode(document.body);
    refreshDocumentTitle();
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (applying) return;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') translateNode(mutation.target);
        if (mutation.type === 'attributes') translateAttributes(mutation.target);
        for (const added of mutation.addedNodes) translateNode(added);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });
  }

  const api = Object.freeze({
    t,
    configure,
    start,
    translateNode,
    normalizeDisplayName,
    normalizeLanguage,
    get language() {
      return language;
    },
    get displayName() {
      return displayName;
    },
  });

  global.CodemanI18n = api;
  global.codemanT = t;
  const nativeConfirm = typeof global.confirm === 'function' ? global.confirm.bind(global) : null;
  const nativeAlert = typeof global.alert === 'function' ? global.alert.bind(global) : null;
  if (nativeConfirm) global.confirm = (message) => nativeConfirm(t(String(message)));
  if (nativeAlert) global.alert = (message) => nativeAlert(t(String(message)));
  document.addEventListener('DOMContentLoaded', start, { once: true });
})(window);
