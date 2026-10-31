import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloudIcon from '@mui/icons-material/Cloud';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import MicIcon from '@mui/icons-material/Mic';
import EditNoteIcon from '@mui/icons-material/EditNote';
import SettingsIcon from '@mui/icons-material/Settings';
import HistoryIcon from '@mui/icons-material/History';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import StopIcon from '@mui/icons-material/Stop';
import { useUiStore } from '@/stores/useUiStore';
import { useMeetingStore } from '@/stores/useMeetingStore';
import { hasStoredTencentAsr } from '@/services/asrConfig';
import { finishActiveSession } from '@/hooks/useSpeechSession';
import { cloudbaseClient } from '@/core/cloud/CloudBaseClient';
import { attachCloudMirror, clearAllLocalData } from '@/core/repo';
import type { LangCode } from '@/types/models';

/** 模式徽标文案：由 cloudStatus + speechLevel 推导 */
function modeBadge(cloudStatus: string, speechLevel: number): { text: string; color: 'default' | 'primary' | 'success' | 'warning' | 'error' } {
  if (speechLevel === 0) return { text: cloudStatus === 'cloud' ? '云端 + 实时识别' : '实时识别中', color: 'success' };
  if (speechLevel === 1) return { text: '录音模式', color: 'warning' };
  return { text: '本地模式（手动）', color: 'default' };
}

/**
 * 全局顶栏：Logo + 导航 + 模式徽标 + 降级提示条 + 设置弹窗。
 */
export default function AppHeader(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();

  const cloudStatus = useUiStore((s) => s.cloudStatus);
  const cloudReason = useUiStore((s) => s.cloudReason);
  const speechLevel = useUiStore((s) => s.speechLevel);
  const speechLabel = useUiStore((s) => s.speechLabel);
  const bannerMsg = useUiStore((s) => s.bannerMsg);
  const bannerKind = useUiStore((s) => s.bannerKind);
  const bannerAction = useUiStore((s) => s.bannerAction);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const setCloudStatus = useUiStore((s) => s.setCloudStatus);
  const toast = useUiStore((s) => s.toast);
  const requestConfirm = useUiStore((s) => s.requestConfirm);

  /* 设置项（偏好） */
  const lang = useUiStore((s) => s.lang);
  const setLang = useUiStore((s) => s.setLang);
  const deviceId = useUiStore((s) => s.deviceId);
  const setDeviceId = useUiStore((s) => s.setDeviceId);
  const energyHintEnabled = useUiStore((s) => s.energyHintEnabled);
  const setEnergyHintEnabled = useUiStore((s) => s.setEnergyHintEnabled);
  const cloudEnabled = useUiStore((s) => s.cloudEnabled);
  const setCloudEnabled = useUiStore((s) => s.setCloudEnabled);
  const starHotkeyEnabled = useUiStore((s) => s.starHotkeyEnabled);
  const setStarHotkeyEnabled = useUiStore((s) => s.setStarHotkeyEnabled);
  const tencentAsr = useUiStore((s) => s.tencentAsr);
  const setTencentAsr = useUiStore((s) => s.setTencentAsr);

  const meetingTitle = useMeetingStore((s) => s.meeting?.title ?? '');
  const meetingStatus = useMeetingStore((s) => s.meeting?.status ?? null);
  const meetingId = useMeetingStore((s) => s.meeting?.id ?? null);

  const [retrying, setRetrying] = useState(false);
  const [endingLive, setEndingLive] = useState(false);

  /** 云端状态变化时，把降级原因同步到顶部提示条 */
  useEffect(() => {
    if (cloudStatus === 'cloud') {
      useUiStore.getState().setBanner(null);
      return;
    }
    if (cloudStatus === 'local' && cloudReason) {
      // 「未配置云环境」属于默认开箱场景，不算降级，不必常驻提示条
      const isDefaultLocal = cloudReason.includes('未配置');
      useUiStore.getState().setBanner(isDefaultLocal ? null : cloudReason, 'info');
    }
  }, [cloudStatus, cloudReason]);

  const badge = modeBadge(cloudStatus, speechLevel);

  /** 手动重试云端连接 */
  const handleRetryCloud = useCallback(async () => {
    setRetrying(true);
    try {
      const status = await cloudbaseClient.retry(3000);
      setCloudStatus(status, cloudbaseClient.getReason());
      if (status === 'cloud') {
        toast.success('云端已连接');
        // 云就绪后把 CloudRepository 挂为本地仓库的镜像，异步追写
        attachCloudMirror();
      } else {
        toast.warning(cloudbaseClient.getReason() || '云端连接失败，已使用本地模式继续');
      }
    } finally {
      setRetrying(false);
    }
  }, [setCloudStatus, toast]);

  /** 清空本地数据 */
  const handleClearData = useCallback(async () => {
    const ok = await requestConfirm({
      title: '清空全部本地数据',
      body: '将删除本机所有会议记录、发言与录音，且不可恢复。建议先导出备份。确定继续吗？',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    await clearAllLocalData();
    useMeetingStore.getState().reset();
    toast.success('本地数据已清空');
    navigate('/');
  }, [navigate, requestConfirm, toast]);

  /** 从顶栏直接结束进行中的会议（复用会话的 finish 链路，绝不重写结束逻辑） */
  const handleFinishLive = useCallback(async () => {
    const ok = await requestConfirm({
      title: '结束会议',
      body: `「${meetingTitle}」正在进行中，麦克风仍在收音。结束后将生成纪要，你可以继续编辑和导出。`,
      confirmText: '结束并整理',
      cancelText: '继续会议',
    });
    if (!ok) return;
    setEndingLive(true);
    try {
      const id = await finishActiveSession();
      if (id) navigate(`/review/${id}`);
    } finally {
      setEndingLive(false);
    }
  }, [meetingTitle, navigate, requestConfirm]);

  const onHome = location.pathname === '/';
  const onLive = location.pathname.startsWith('/live');
  const onReview = location.pathname.startsWith('/review');
  const onQuick = location.pathname.startsWith('/quick');

  /**
   * ★ 隐私可见性：离开实时页后麦克风仍在收音，
   *   这里常驻一条紧凑提示，让用户随时看得见、回得去、结束得掉。
   */
  const showLiveHint = meetingStatus === 'active' && !onLive && Boolean(meetingId);

  return (
    <>
      <AppBar position="sticky" color="primary" elevation={0} className="no-print">
        <Toolbar className="gap-2" sx={{ minHeight: 56 }}>
          <div className="flex items-center gap-2">
            <RecordVoiceOverIcon />
            <Typography variant="h6" component="div" sx={{ letterSpacing: '.02em' }}>
              MeetingMind
            </Typography>
          </div>

          <div className="ml-4 flex items-center gap-1">
            <Button
              size="small"
              color="inherit"
              startIcon={<HistoryIcon />}
              onClick={() => navigate('/')}
              sx={{ opacity: onHome ? 1 : 0.75 }}
            >
              历史
            </Button>
            <Button
              size="small"
              color="inherit"
              startIcon={<MicIcon />}
              onClick={() => navigate(onLive ? location.pathname : '/live/new')}
              sx={{ opacity: onLive ? 1 : 0.75 }}
            >
              实时
            </Button>
            <Button
              size="small"
              color="inherit"
              startIcon={<EditNoteIcon />}
              onClick={() => navigate(onReview ? location.pathname : '/')}
              sx={{ opacity: onReview ? 1 : 0.75 }}
            >
              纪要
            </Button>
            <Button
              size="small"
              color="inherit"
              startIcon={<EditNoteIcon />}
              onClick={() => navigate(onQuick ? location.pathname : '/quick')}
              sx={{ opacity: onQuick ? 1 : 0.75 }}
            >
              速记
            </Button>
          </div>

          {meetingTitle && meetingStatus !== 'ended' ? (
            <Chip
              size="small"
              label={meetingTitle}
              sx={{ ml: 2, bgcolor: 'rgba(255,255,255,.16)', color: '#fff', maxWidth: 220 }}
            />
          ) : null}

          <div className="flex-1" />

          {/* 会议进行中 · 麦克风收音中（仅在离开实时页时显示） */}
          {showLiveHint ? (
            <div className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 ring-1 ring-inset ring-white/40">
              <FiberManualRecordIcon
                sx={{
                  fontSize: 10,
                  color: '#EF4444',
                  animation: 'mm-live-pulse 1.4s ease-in-out infinite',
                  '@keyframes mm-live-pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.25 } },
                }}
              />
              <Typography variant="caption" sx={{ color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>
                会议进行中 · 麦克风收音中
              </Typography>
              <Button
                size="small"
                color="inherit"
                onClick={() => meetingId && navigate(`/live/${meetingId}`)}
                sx={{ minWidth: 0, px: 0.75, whiteSpace: 'nowrap' }}
              >
                返回会议
              </Button>
              <Button
                size="small"
                variant="contained"
                color="error"
                startIcon={<StopIcon sx={{ fontSize: 14 }} />}
                onClick={handleFinishLive}
                disabled={endingLive}
                sx={{ minWidth: 0, px: 0.75, whiteSpace: 'nowrap' }}
              >
                {endingLive ? '结束中…' : '结束会议'}
              </Button>
            </div>
          ) : null}

          <div className="flex items-center gap-1">
            <Tooltip title={speechLabel} arrow>
              <Chip size="small" color={badge.color} label={badge.text} icon={speechLevel === 0 ? <MicIcon /> : undefined} />
            </Tooltip>
            <Tooltip title={cloudStatus === 'cloud' ? '云端镜像已启用' : cloudReason || '未连接云端'} arrow>
              <Chip
                size="small"
                variant="outlined"
                sx={{ color: '#fff', borderColor: 'rgba(255,255,255,.5)' }}
                icon={cloudStatus === 'cloud' ? <CloudIcon /> : <CloudOffIcon />}
                label={cloudStatus === 'cloud' ? '云端' : cloudStatus === 'probing' ? '探测中' : '本地'}
              />
            </Tooltip>
          </div>

          <Tooltip title="设置" arrow>
            <IconButton color="inherit" onClick={openSettings} size="small">
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      {/* 降级提示条：永不静默失败 */}
      {bannerMsg ? (
        <div className="no-print px-3 pt-2">
          <Alert
            severity={bannerKind === 'success' ? 'success' : bannerKind === 'error' ? 'error' : bannerKind === 'warning' ? 'warning' : 'info'}
            action={
              bannerAction ? (
                <Button size="small" onClick={bannerAction.onClick}>
                  {bannerAction.text}
                </Button>
              ) : undefined
            }
          >
            {bannerMsg}
          </Alert>
        </div>
      ) : null}

      {/* 设置弹窗 */}
      <Dialog open={settingsOpen} onClose={closeSettings} maxWidth="sm" fullWidth>
        <DialogTitle>设置</DialogTitle>
        <DialogContent dividers className="flex flex-col gap-4">
          {/* 云端 */}
          <div className="flex flex-col gap-2">
            <Typography variant="subtitle2">云端（可选）</Typography>
            <div className="flex items-center gap-2">
              <Chip
                size="small"
                color={cloudStatus === 'cloud' ? 'success' : cloudStatus === 'probing' ? 'default' : 'warning'}
                label={cloudStatus === 'cloud' ? '已连接' : cloudStatus === 'probing' ? '探测中' : '本地模式'}
              />
              <Typography variant="body2" color="text.secondary" className="flex-1">
                {cloudStatus === 'cloud' ? '数据会异步镜像到云端' : cloudReason || '未配置云环境，全部功能本地可用'}
              </Typography>
              <Button size="small" variant="outlined" disabled={retrying || !cloudEnabled} onClick={handleRetryCloud}>
                {retrying ? '重试中…' : '重试连接'}
              </Button>
            </div>
            <FormControlLabel
              control={
                <Switch
                  checked={cloudEnabled}
                  onChange={(e) => {
                    setCloudEnabled(e.target.checked);
                    if (!e.target.checked) {
                      cloudbaseClient.forceLocal('已切换为纯本地模式');
                      setCloudStatus('local', '已切换为纯本地模式');
                    }
                  }}
                />
              }
              label="允许连接云端（关闭 = 纯本地，永不上传）"
            />
            <Typography variant="caption" color="text.secondary">
              关闭云端后，实时识别、结构化整理、导出与历史检索全部照常可用，仅失去云端备份与 AI 整理能力。
            </Typography>
          </div>

          <Divider />

          {/* 识别 */}
          <div className="flex flex-col gap-2">
            <Typography variant="subtitle2">识别</Typography>
            <TextField
              select
              size="small"
              label="识别语言"
              value={lang}
              onChange={(e) => setLang(e.target.value as LangCode)}
              sx={{ maxWidth: 220 }}
            >
              <MenuItem value="zh-CN">中文（简体）</MenuItem>
              <MenuItem value="en-US">English (US)</MenuItem>
            </TextField>
            <TextField
              size="small"
              label="麦克风设备 ID"
              value={deviceId}
              placeholder="留空使用系统默认设备"
              onChange={(e) => setDeviceId(e.target.value)}
              helperText="远程会议请开启扬声器外放或安装虚拟声卡，浏览器无法直接采集系统内部音频"
            />
            <FormControlLabel
              control={
                <Switch checked={energyHintEnabled} onChange={(e) => setEnergyHintEnabled(e.target.checked)} />
              }
              label="能量突变提示（仅提示，绝不自动改写发言人归属）"
            />
            <FormControlLabel
              control={
                <Switch checked={starHotkeyEnabled} onChange={(e) => setStarHotkeyEnabled(e.target.checked)} />
              }
              label="启用 Ctrl/Cmd + M 打点快捷键（与系统冲突时可关闭）"
            />
          </div>

          <Divider />

          {/* 腾讯云实时语音识别（可选） */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Typography variant="subtitle2">腾讯云实时语音识别（可选）</Typography>
              <Chip
                size="small"
                color={hasStoredTencentAsr() ? 'success' : 'default'}
                label={hasStoredTencentAsr() ? '已配置' : '未配置'}
              />
            </div>
            <Typography variant="caption" color="text.secondary">
              浏览器原生语音识别在部分网络下不可用，可在此填入腾讯云凭证改用云端实时转写（实时字幕更稳）。凭证仅保存在本机浏览器，不会上传到本应用服务器。
            </Typography>
            <TextField
              size="small"
              type="password"
              label="SecretId"
              value={tencentAsr.secretId}
              onChange={(e) => setTencentAsr({ secretId: e.target.value })}
              autoComplete="off"
            />
            <TextField
              size="small"
              type="password"
              label="SecretKey"
              value={tencentAsr.secretKey}
              onChange={(e) => setTencentAsr({ secretKey: e.target.value })}
              autoComplete="off"
            />
            <TextField
              size="small"
              label="AppId"
              value={tencentAsr.appId}
              onChange={(e) => setTencentAsr({ appId: e.target.value })}
              autoComplete="off"
            />
          </div>

          <Divider />

          {/* 数据 */}
          <div className="flex flex-col gap-2">
            <Typography variant="subtitle2">数据</Typography>
            <Typography variant="body2" color="text.secondary">
              会议数据保存在本机浏览器 IndexedDB 中，建议定期导出 JSON 备份。
            </Typography>
            <div>
              <Button color="error" variant="outlined" size="small" onClick={handleClearData}>
                清空全部本地数据
              </Button>
            </div>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSettings}>关闭</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
