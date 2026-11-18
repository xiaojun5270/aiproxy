import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import type { LucideIcon } from 'lucide-react-native';
import {
  Activity,
  Bot,
  Boxes,
  Check,
  CheckSquare2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Clock3,
  CloudCog,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Filter,
  Gauge,
  History,
  Layers3,
  LogIn,
  Network,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  SearchX,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  Wifi,
  Wrench,
  X,
  Zap,
} from 'lucide-react-native';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { StructuredDataView } from '@/src/components/structured-form';
import { ProviderIcon } from '@/src/components/provider-icon';
import { AppSwitch, EmptyState, ErrorState, FullScreenSafeArea, Page, PageHeader, SearchField, SheetHandle } from '@/src/components/ui';
import {
  accountEgress,
  accountIdentity,
  accountLastUsed,
  accountProvider,
  accountSearchText,
  accountStatus,
  accountStatusLabels,
  accountStatusNeedsAttention,
  accountStatusReason,
  maskAccountIdentity,
  type UpstreamAccountStatus,
} from '@/src/lib/account-display';
import { apiFetch, apiJson, firstArray, type ApiResult } from '@/src/lib/api';
import { documentMultipartBody } from '@/src/lib/file-transfer';
import { queryClient } from '@/src/lib/query-client';
import { useAppTheme } from '@/src/lib/theme';
import { useScreenFocus } from '@/src/lib/use-screen-focus';
import { setAdminAccountEnabled } from '@/src/services/admin';
import { setPrivacyMode, usePrivacyMode } from '@/src/store/privacy';
import type { ApiRecord } from '@/src/types/api';

type StatusFilter = 'all' | UpstreamAccountStatus;
type FilterMode = 'status' | 'provider' | 'egress' | '';
type ListMode = 'attention' | 'provider';
type ModelTestState = { ok: boolean; message: string; testedAt: string };
type ModelTestProgress = { completed: number; total: number };
type AccountDraft = {
  label: string;
  priority: string;
  concurrencyLimit: string;
  status: string;
  egressSelector: string;
  wsEnabled: boolean;
  credentials: Record<string, string>;
};
type WarmupDraft = { enabled: boolean; times: string[]; timezone: string; model: string };
type ChoiceOption = { key: string; label: string; detail?: string; count?: number };

const credentialFields: Record<string, Array<{ key: string; label: string; placeholder: string; secure?: boolean }>> = {
  cursor: [{ key: 'machine_id', label: 'Machine ID', placeholder: 'storage.serviceMachineId' }],
  qianwen: [{ key: 'console_cookie', label: '控制台 Cookie', placeholder: 'login_qianwenai_ticket=...', secure: true }],
  qwen: [{ key: 'console_cookie', label: '控制台 Cookie', placeholder: 'login_qianwenai_ticket=...', secure: true }],
  ark: [
    { key: 'volc_access_key_id', label: 'Access Key ID', placeholder: 'AKLT...' },
    { key: 'volc_secret_access_key', label: 'Secret Access Key', placeholder: '仅在需要替换时填写', secure: true },
  ],
  doubao: [
    { key: 'volc_access_key_id', label: 'Access Key ID', placeholder: 'AKLT...' },
    { key: 'volc_secret_access_key', label: 'Secret Access Key', placeholder: '仅在需要替换时填写', secure: true },
  ],
};

const statusOrder: UpstreamAccountStatus[] = ['active', 'error', 'needs_reauth', 'suspended', 'rate_limited', 'cooldown', 'disabled'];
const accountPageSize = 20;
const maxAccountConcurrency = 10_000;

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function recordValue(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function arrayFrom(value: unknown, keys: string[]) {
  if (Array.isArray(value)) return value.filter((item): item is ApiRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  const record = recordValue(value);
  for (const key of keys) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((item): item is ApiRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  return [];
}

function nestedNumber(item: ApiRecord | undefined, keys: string[]) {
  if (!item) return undefined;
  const queue = [item];
  const seen = new Set<ApiRecord>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const key of keys) {
      const value = Number(current[key]);
      if (Number.isFinite(value)) return value;
    }
    for (const key of ['quota', 'usage', 'limits', 'billing', 'metadata']) {
      const nested = recordValue(current[key]);
      if (Object.keys(nested).length) queue.push(nested);
    }
  }
  return undefined;
}

function quotaAccounts(payload: unknown) {
  const root = recordValue(payload);
  const direct = arrayFrom(root, ['accounts', 'items']);
  const groups = arrayFrom(root, ['groups', 'providers']);
  return direct.length ? direct : groups.flatMap((group) => arrayFrom(group, ['accounts', 'items']));
}

function quotaAccountMap(payload: unknown) {
  return new Map(quotaAccounts(payload).flatMap((item) => {
    const id = stringValue(item.id ?? item.account_id);
    return id ? [[id, item] as const] : [];
  }));
}

function concurrencyRows(payload: unknown) {
  const root = recordValue(payload);
  return arrayFrom(root, ['accounts', 'rows', 'items', 'concurrency']);
}

function concurrencyRowMap(payload: unknown) {
  return new Map(concurrencyRows(payload).flatMap((item) => {
    const id = stringValue(item.id ?? item.account_id);
    return id ? [[id, item] as const] : [];
  }));
}

function pluginProviderDefinitions(payload: unknown) {
  return arrayFrom(payload, ['plugins', 'items', 'data', 'list']).flatMap((entry) => {
    if (entry.revoked_at || entry.active === false || entry.activation_state === 'inactive') return [];
    const manifest = recordValue(entry.manifest ?? entry);
    return arrayFrom(recordValue(manifest.provides), ['providers']);
  });
}

function providerActionMap(builtinPayload: unknown, pluginPayload: unknown) {
  const definitions = [...arrayFrom(builtinPayload, ['providers', 'items', 'data', 'list']), ...pluginProviderDefinitions(pluginPayload)];
  return new Map(definitions.flatMap((definition) => {
    const provider = stringValue(definition.name ?? definition.provider ?? definition.id).toLowerCase();
    const actions = arrayFrom(recordValue(definition.account), ['actions']);
    return provider && actions.length ? [[provider, actions] as const] : [];
  }));
}

function providerAccountMap(builtinPayload: unknown, pluginPayload: unknown) {
  const definitions = [...arrayFrom(builtinPayload, ['providers', 'items', 'data', 'list']), ...pluginProviderDefinitions(pluginPayload)];
  return new Map(definitions.flatMap((definition) => {
    const provider = stringValue(definition.name ?? definition.provider ?? definition.id).toLowerCase();
    const account = recordValue(definition.account);
    return provider && Object.keys(account).length ? [[provider, account] as const] : [];
  }));
}

function accountCredentialFields(item: ApiRecord, providerAccount?: ApiRecord) {
  const dynamic = arrayFrom(providerAccount, ['fields']).flatMap((field) => {
    const key = stringValue(field.name ?? field.key);
    if (!key) return [];
    return [{ key, label: localizedText(field.label) || key, placeholder: stringValue(field.placeholder), secure: field.type === 'password' || field.secret === true }];
  });
  return dynamic.length ? dynamic : credentialFields[stringValue(item.provider).toLowerCase()] ?? [];
}

function quotaLines(item?: ApiRecord) {
  if (!item) return [];
  const windows = arrayFrom(recordValue(item.quota), ['windows', 'items']);
  const sources = windows.length ? windows : [recordValue(item.quota), item].filter((value) => Object.keys(value).length);
  return sources.flatMap((source) => {
    const used = nestedNumber(source, ['used_percent', 'usage_percent', 'percent_used']);
    const remaining = nestedNumber(source, ['remaining', 'available', 'balance', 'credit']);
    const limit = nestedNumber(source, ['limit', 'total', 'max']);
    const label = stringValue(source.label ?? source.name ?? source.key ?? source.period ?? source.window);
    if (used !== undefined) return [`${label ? `${label} ` : ''}${Math.max(0, Math.min(100, used)).toFixed(used >= 10 ? 0 : 1)}% 已用`];
    if (remaining !== undefined && limit !== undefined) return [`${label ? `${label} ` : ''}${remaining.toLocaleString('zh-CN')} / ${limit.toLocaleString('zh-CN')}`];
    if (remaining !== undefined) return [`${label ? `${label} ` : ''}${remaining.toLocaleString('zh-CN')}`];
    return [];
  });
}

function quotaHeadline(item?: ApiRecord) {
  const lines = quotaLines(item);
  return lines.slice(0, 2).join(' · ');
}

function maskedIdentity(item: ApiRecord, privacy: boolean) {
  const identity = accountIdentity(item);
  if (!privacy) return identity;
  return {
    primary: maskAccountIdentity(identity.primary),
    secondary: maskAccountIdentity(identity.secondary),
  };
}

function accountAttentionRank(item: ApiRecord, proxies: ApiRecord[], proxiesLoaded: boolean, now: number) {
  const status = accountStatus(item, now);
  if (accountStatusNeedsAttention(status) || accountEgress(item, proxies, proxiesLoaded).missing) return 0;
  if (status === 'cooldown' || status === 'rate_limited') return 1;
  if (status === 'active') return 2;
  return 3;
}

function accountId(item: ApiRecord) {
  return stringValue(item.id);
}

function accountIsDisabled(item: ApiRecord) {
  const status = stringValue(item.status).toLowerCase();
  return item.disabled === true || item.enabled === false || status === 'disabled' || status === 'auto_disabled' || status === 'inactive';
}

function availableModelId(item: ApiRecord) {
  return stringValue(item.id ?? item.model ?? item.model_id ?? item.name);
}

function modelArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as ApiRecord;
  for (const key of ['models', 'items', 'data', 'list', 'results', 'rows']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = modelArray(value);
      if (nested.length) return nested;
    }
  }
  return availableModelId(record) ? [record] : [];
}

function normalizeAvailableModels(payload: unknown, provider: string): ApiRecord[] {
  return modelArray(payload).flatMap((value) => {
    if (typeof value === 'string' || typeof value === 'number') return [{ id: String(value), provider }];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as ApiRecord;
    if (!availableModelId(item) && Array.isArray(item.models)) {
      return normalizeAvailableModels(item.models, stringValue(item.provider ?? item.name) || provider);
    }
    return availableModelId(item) ? [{ ...item, provider: item.provider ?? provider }] : [];
  });
}

function findModelEnvelope(payload: unknown): ApiRecord | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as ApiRecord;
  if (typeof record.supported === 'boolean' || Array.isArray(record.models)) return record;
  for (const key of ['data', 'result', 'payload']) {
    const nested = findModelEnvelope(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function modelContext(item: ApiRecord) {
  const value = Number(item.context_window ?? item.context_length ?? item.max_context_tokens ?? item.input_token_limit);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M 上下文`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K 上下文`;
  return `${value} 上下文`;
}

function modelTestOutcome(payload: unknown) {
  const outer = recordValue(payload);
  const nested = Object.keys(recordValue(outer.data)).length ? recordValue(outer.data) : outer;
  const success = nested.success ?? nested.ok ?? outer.success ?? outer.ok;
  const error = nested.error ?? nested.message ?? outer.error ?? outer.message;
  if (success === false) throw new Error(stringValue(error) || '模型不可用');
  const latency = Number(nested.latency_ms ?? nested.latency ?? outer.latency_ms ?? outer.latency);
  return Number.isFinite(latency) && latency >= 0 ? `可用 · ${Math.round(latency)} ms` : '模型可用';
}

function modelTestTime() {
  const date = new Date();
  try {
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':');
  }
}

function modelTestError(error: unknown) {
  return error instanceof Error && typeof error.message === 'string' && error.message.trim() ? error.message : '测试失败';
}

async function requestModelTest(account: string, model: string, signal: AbortSignal): Promise<ModelTestState> {
  try {
    const payload = await apiJson(`/admin/accounts/${encodeURIComponent(account)}/models/test`, {
      method: 'POST',
      body: JSON.stringify({ model }),
      timeoutMs: 60000,
      signal,
    });
    return { ok: true, message: modelTestOutcome(payload), testedAt: modelTestTime() };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, message: modelTestError(error), testedAt: modelTestTime() };
  }
}

function formatTimestamp(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('zh-CN');
}

function statusTone(status: UpstreamAccountStatus, colors: ReturnType<typeof useAppTheme>) {
  if (status === 'active') return { background: colors.successBg, foreground: colors.success };
  if (status === 'cooldown' || status === 'rate_limited') return { background: colors.warningBg, foreground: colors.warning };
  return { background: colors.dangerBg, foreground: colors.danger };
}

function safeFilename(value: string | undefined) {
  return (value?.trim() || `accounts-export-${Date.now()}.json`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

function exportBytes(result: ApiResult) {
  if (result.bytes) return result.bytes;
  if (result.kind === 'json') return new TextEncoder().encode(JSON.stringify(result.data, null, 2));
  if (result.kind === 'text') return new TextEncoder().encode(String(result.data ?? ''));
  throw new Error('服务器没有返回可导出的文件');
}

async function shareExportResult(result: ApiResult) {
  const bytes = exportBytes(result);
  const filename = safeFilename(result.filename);
  const mimeType = (result.contentType || 'application/json').split(';')[0];
  if (Platform.OS === 'web') {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (!await Sharing.isAvailableAsync()) throw new Error('当前设备不支持文件分享');
  const file = new ExpoFile(Paths.cache, `${Date.now()}-${filename}`);
  file.create({ overwrite: true, intermediates: true });
  file.write(bytes);
  await Sharing.shareAsync(file.uri, {
    dialogTitle: '导出上游账号',
    mimeType,
    UTI: mimeType.includes('json') ? 'public.json' : 'public.data',
  });
}

function SheetFrame({ visible, onClose, children, maxHeight = '88%' }: { visible: boolean; onClose: () => void; children: React.ReactNode; maxHeight?: `${number}%` }) {
  const colors = useAppTheme();
  return <Modal visible={visible} transparent statusBarTranslucent navigationBarTranslucent animationType="slide" onRequestClose={onClose}>
    <FullScreenSafeArea style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.sheetBackdrop }}>
      <Pressable accessibilityLabel="关闭弹层" onPress={onClose} style={{ flex: 1 }} />
      <View style={{ maxHeight, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, backgroundColor: colors.page, padding: 16, gap: 12, shadowColor: colors.shadow, shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: -4 }, elevation: 8 }}>
        <SheetHandle />
        {children}
      </View>
    </FullScreenSafeArea>
  </Modal>;
}

function SheetHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  const colors = useAppTheme();
  return <View style={{ minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text numberOfLines={1} style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>{title}</Text>{subtitle ? <Text numberOfLines={1} style={{ color: colors.subtext, fontSize: 11 }}>{subtitle}</Text> : null}</View>
    <Pressable accessibilityLabel="关闭" onPress={onClose} style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}><X color={colors.subtext} size={17} /></Pressable>
  </View>;
}

function CompactButton({ icon: Icon, label, onPress, primary = false, busy = false, disabled = false }: { icon: LucideIcon; label: string; onPress: () => void; primary?: boolean; busy?: boolean; disabled?: boolean }) {
  const colors = useAppTheme();
  const inactive = disabled || busy;
  return <Pressable disabled={inactive} onPress={onPress} style={({ pressed }) => ({ flexGrow: 1, flexBasis: 104, minWidth: 0, minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: primary ? colors.primary : colors.border, backgroundColor: primary ? colors.primary : colors.card, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: inactive ? 0.48 : pressed ? 0.68 : 1 })}>
    {busy ? <ActivityIndicator color={primary ? '#fff' : colors.primary} size="small" /> : <Icon color={primary ? '#fff' : colors.primary} size={15} />}
    <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: primary ? '#fff' : colors.primary, fontSize: 11, fontWeight: '800' }}>{label}</Text>
  </Pressable>;
}

function FilterButton({ icon: Icon, label, active, onPress }: { icon: LucideIcon; label: string; active: boolean; onPress: () => void }) {
  const colors = useAppTheme();
  return <Pressable onPress={onPress} style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primarySoft : colors.card, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7, opacity: pressed ? 0.66 : 1 })}>
    <Icon color={active ? colors.primary : colors.subtext} size={15} />
    <Text numberOfLines={1} style={{ flex: 1, color: active ? colors.primary : colors.text, fontSize: 11, fontWeight: '700' }}>{label}</Text>
    <ChevronDown color={active ? colors.primary : colors.subtext} size={14} />
  </Pressable>;
}

function AccountToggleButton({ account, busy, locked, onPress }: { account: ApiRecord; busy: boolean; locked: boolean; onPress: () => void }) {
  const colors = useAppTheme();
  const enable = accountIsDisabled(account);
  const background = enable ? colors.success : colors.danger;
  return <Pressable
    accessibilityLabel={enable ? '启用账号' : '禁用账号'}
    accessibilityRole="button"
    accessibilityState={{ disabled: locked || busy, busy }}
    disabled={locked || busy}
    hitSlop={4}
    onPress={(event) => { event.stopPropagation(); onPress(); }}
    style={({ pressed }) => ({ flexShrink: 0, minWidth: 58, height: 30, paddingHorizontal: 9, borderRadius: 9, backgroundColor: background, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, opacity: locked ? 0.48 : pressed ? 0.72 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] })}
  >
    {busy ? <ActivityIndicator color="#fff" size="small" /> : <><Power color="#fff" size={12} strokeWidth={2.5} /><Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{enable ? '启用' : '禁用'}</Text></>}
  </Pressable>;
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  const colors = useAppTheme();
  const foreground = tone === 'success' ? colors.success : tone === 'danger' ? colors.danger : colors.text;
  return <View style={{ minHeight: 30, flexDirection: 'row', alignItems: 'baseline', gap: 4 }}><Text style={{ color: foreground, fontSize: 14, fontWeight: '900' }}>{value}</Text><Text style={{ color: colors.subtext, fontSize: 11, fontWeight: '600' }}>{label}</Text></View>;
}

function AccountCard({ item, quota, concurrency, proxies, proxiesLoaded, privacy, selected, now, toggling, toggleLocked, onPress, onSelect, onToggle }: { item: ApiRecord; quota?: ApiRecord; concurrency?: ApiRecord; proxies: ApiRecord[]; proxiesLoaded: boolean; privacy: boolean; selected: boolean; now: number; toggling: boolean; toggleLocked: boolean; onPress: () => void; onSelect: () => void; onToggle: () => void }) {
  const colors = useAppTheme();
  const identity = maskedIdentity(item, privacy);
  const provider = accountProvider(item);
  const status = accountStatus(item, now);
  const egress = accountEgress(item, proxies, proxiesLoaded);
  const reason = accountStatusReason(item, status);
  const plan = stringValue(item.plan_label);
  const priority = Number(item.priority ?? 0);
  const ownLimit = Number(concurrency?.limit ?? item.concurrency_limit ?? 0) || 0;
  const inuse = Number(concurrency?.inuse ?? concurrency?.in_use ?? 0) || 0;
  const queued = Number(concurrency?.queued ?? 0) || 0;
  const quotaText = quotaHeadline(quota ?? item);
  const warmupTimes = Array.isArray(item.warmup_times) ? item.warmup_times.map(String).filter(Boolean) : [];
  const egressText = egress.missing ? `出口缺失 · ${egress.label}` : egress.direct ? '直连' : `经 ${egress.label}`;
  return <Pressable accessibilityLabel={`编辑账号 ${identity.primary}`} accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ minHeight: 88, borderRadius: 16, borderWidth: 1, borderColor: egress.missing ? colors.warning : pressed ? colors.primary : colors.border, backgroundColor: pressed ? colors.mutedCard : colors.card, paddingHorizontal: 10, paddingVertical: 8, gap: 4, opacity: pressed ? 0.76 : 1 })}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
      <Pressable accessibilityLabel={selected ? `取消选择 ${identity.primary}` : `选择 ${identity.primary}`} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} hitSlop={5} onPress={(event) => { event.stopPropagation(); onSelect(); }} style={{ width: 26, height: 36, alignItems: 'center', justifyContent: 'center' }}>{selected ? <CheckSquare2 color={colors.primary} size={18} /> : <Square color={colors.subtext} size={18} />}</Pressable>
      <ProviderIcon provider={item} size={36} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 13, fontWeight: '800' }}>{identity.primary}</Text><AccountToggleButton account={item} busy={toggling} locked={toggleLocked} onPress={onToggle} /></View>
        {identity.secondary ? <Text numberOfLines={1} style={{ color: colors.subtext, fontSize: 11 }}>{identity.secondary}</Text> : null}
        <Text numberOfLines={1} style={{ color: colors.subtext, fontSize: 11, fontWeight: '600' }}>{provider.label}{plan ? ` / ${plan}` : ''}</Text>
      </View>
    </View>
    <View style={{ marginLeft: 80, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 }}><Network color={egress.missing ? colors.warning : colors.subtext} size={13} /><Text numberOfLines={1} style={{ flex: 1, color: egress.missing ? colors.warning : colors.subtext, fontSize: 11, fontWeight: egress.missing ? '700' : '500' }}>{egressText}</Text></View>
      <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 5 }}><Clock3 color={colors.subtext} size={13} /><Text style={{ color: colors.subtext, fontSize: 11 }}>{accountLastUsed(item.last_used_at, now)}</Text></View>
    </View>
    {quotaText || inuse || queued || ownLimit ? <View style={{ marginLeft: 80, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {quotaText ? <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 }}><Gauge color={colors.subtext} size={13} /><Text numberOfLines={1} style={{ flex: 1, color: colors.subtext, fontSize: 11 }}>{quotaText}</Text></View> : <View style={{ flex: 1 }} />}
      {inuse || queued || ownLimit ? <Text style={{ color: colors.subtext, fontSize: 11 }}>并发 {inuse}/{ownLimit || '∞'}{queued ? ` · 排队 ${queued}` : ''}</Text> : null}
    </View> : null}
    {reason ? <Text numberOfLines={2} style={{ marginLeft: 80, color: statusTone(status, colors).foreground, fontSize: 11, lineHeight: 14 }}>{reason}</Text> : null}
    {item.ws_enabled || priority !== 0 || item.warmup_enabled || item.models_probe_error ? <View style={{ marginLeft: 80, flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      {item.ws_enabled ? <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7, backgroundColor: colors.mutedCard }}><Text style={{ color: colors.subtext, fontSize: 11, fontWeight: '700' }}>WS</Text></View> : null}
      {priority !== 0 ? <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7, backgroundColor: colors.mutedCard }}><Text style={{ color: colors.subtext, fontSize: 11, fontWeight: '700' }}>优先级 {priority}</Text></View> : null}
      {item.warmup_enabled ? <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7, backgroundColor: item.warmup_last_error ? colors.warningBg : colors.mutedCard }}><Text numberOfLines={1} style={{ color: item.warmup_last_error ? colors.warning : colors.subtext, fontSize: 11, fontWeight: '700' }}>预热{warmupTimes.length ? ` ${warmupTimes.join(' ')}` : ''}</Text></View> : null}
      {item.models_probe_error ? <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7, backgroundColor: colors.warningBg }}><Text style={{ color: colors.warning, fontSize: 11, fontWeight: '700' }}>模型探测失败</Text></View> : null}
    </View> : null}
  </Pressable>;
}

function ActionRow({ icon: Icon, label, onPress, busy = false, disabled = false, danger = false }: { icon: LucideIcon; label: string; onPress: () => void; busy?: boolean; disabled?: boolean; danger?: boolean }) {
  const colors = useAppTheme();
  return <Pressable disabled={disabled || busy} onPress={onPress} style={({ pressed }) => ({ minHeight: 46, borderTopWidth: 1, borderTopColor: colors.rowBorder, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: disabled ? 0.42 : pressed ? 0.62 : 1 })}>
    <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: danger ? colors.dangerBg : colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}>{busy ? <ActivityIndicator color={danger ? colors.danger : colors.primary} size="small" /> : <Icon color={danger ? colors.danger : colors.subtext} size={15} />}</View>
    <Text style={{ flex: 1, color: danger ? colors.danger : colors.text, fontSize: 11, fontWeight: '700' }}>{label}</Text>
  </Pressable>;
}

function DiagnosticRow({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'success' | 'warning' | 'danger' }) {
  const colors = useAppTheme();
  const foreground = tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : colors.text;
  return <View style={{ minHeight: 42, borderTopWidth: 1, borderTopColor: colors.rowBorder, flexDirection: 'row', alignItems: 'center', gap: 10 }}><Text style={{ flex: 1, color: colors.subtext, fontSize: 11 }}>{label}</Text><Text numberOfLines={2} style={{ maxWidth: '65%', color: foreground, fontSize: 11, lineHeight: 15, fontWeight: '700', textAlign: 'right' }}>{value}</Text></View>;
}

function AccountDiagnosticsSheet({ account, quota, concurrency, proxies, proxiesLoaded, privacy, onClose, onEdit, onModels, onActions }: { account?: ApiRecord; quota?: ApiRecord; concurrency?: ApiRecord; proxies: ApiRecord[]; proxiesLoaded: boolean; privacy: boolean; onClose: () => void; onEdit: () => void; onModels: () => void; onActions: () => void }) {
  if (!account) return <SheetFrame visible={false} onClose={onClose}><View /></SheetFrame>;
  const identity = maskedIdentity(account, privacy);
  const status = accountStatus(account);
  const reason = accountStatusReason(account, status);
  const egress = accountEgress(account, proxies, proxiesLoaded);
  const quotaDetails = quotaLines(quota ?? account);
  const limit = Number(concurrency?.limit ?? account.concurrency_limit ?? 0) || 0;
  const inuse = Number(concurrency?.inuse ?? concurrency?.in_use ?? 0) || 0;
  const queued = Number(concurrency?.queued ?? 0) || 0;
  const models = Number(account.models_count);
  return <SheetFrame visible onClose={onClose} maxHeight="92%">
    <SheetHeader title={identity.primary || '账号诊断'} subtitle={[accountProvider(account).label, identity.secondary].filter(Boolean).join(' · ')} onClose={onClose} />
    <ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 4 }}>
      <DiagnosticRow label="状态" value={accountStatusLabels[status]} tone={status === 'active' ? 'success' : accountStatusNeedsAttention(status) ? 'danger' : 'warning'} />
      {reason ? <DiagnosticRow label="状态原因" value={reason} tone="danger" /> : null}
      <DiagnosticRow label="网络出口" value={egress.missing ? `${egress.label}（已失效）` : egress.direct ? '默认网络路径' : egress.label} tone={egress.missing ? 'danger' : 'normal'} />
      {quotaDetails.length ? quotaDetails.map((line, index) => <DiagnosticRow key={`${line}-${index}`} label={index ? `余量 ${index + 1}` : '余量'} value={line} />) : <DiagnosticRow label="余量" value="暂无额度数据" tone="warning" />}
      <DiagnosticRow label="并发" value={`${inuse} / ${limit || '∞'}${queued ? ` · 排队 ${queued}` : ''}`} tone={queued ? 'warning' : 'normal'} />
      <DiagnosticRow label="优先级" value={`P${Number(account.priority ?? 0) || 0}`} />
      <DiagnosticRow label="模型范围" value={Number.isFinite(models) ? `${models} 个模型` : '进入模型页查看'} tone={account.models_probe_error ? 'warning' : 'normal'} />
      {account.models_probe_error ? <DiagnosticRow label="模型探测" value={String(account.models_probe_error)} tone="warning" /> : null}
      <DiagnosticRow label="最近使用" value={accountLastUsed(account.last_used_at)} />
      {account.warmup_last_error ? <DiagnosticRow label="预热异常" value={String(account.warmup_last_error)} tone="warning" /> : null}
    </ScrollView>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><CompactButton icon={Pencil} label="编辑配置" onPress={onEdit} /><CompactButton icon={Boxes} label="模型与开关" primary onPress={onModels} /><CompactButton icon={SlidersHorizontal} label="账号操作" onPress={onActions} /></View>
  </SheetFrame>;
}

function AccountActionsSheet({ account, dynamicActions, busyAction, onClose, onDiagnose, onRecover, onReauth, onEdit, onModels, onWarmup, onAutomation, onDynamicAction, onToggle, onExport, onDelete }: { account?: ApiRecord; dynamicActions: ApiRecord[]; busyAction: string; onClose: () => void; onDiagnose: () => void; onRecover: () => void; onReauth: () => void; onEdit: () => void; onModels: () => void; onWarmup: () => void; onAutomation: () => void; onDynamicAction: (action: ApiRecord) => void; onToggle: () => void; onExport: () => void; onDelete: () => void }) {
  const identity = account ? accountIdentity(account) : { primary: '', secondary: '' };
  const provider = account ? accountProvider(account) : accountProvider('');
  const status = account ? accountStatus(account) : 'active';
  const rawDisabled = account ? accountIsDisabled(account) : false;
  return <SheetFrame visible={Boolean(account)} onClose={onClose} maxHeight="88%">
    <SheetHeader title={identity.primary || '上游账号'} subtitle={[provider.label, identity.secondary].filter(Boolean).join(' · ')} onClose={onClose} />
    <ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 2 }}>
      {status === 'needs_reauth' ? <ActionRow icon={LogIn} label="重新登录" onPress={onReauth} disabled={Boolean(busyAction)} /> : null}
      {status !== 'active' ? <ActionRow icon={RotateCcw} label="恢复账号" onPress={onRecover} busy={busyAction === 'recover'} disabled={Boolean(busyAction) && busyAction !== 'recover'} /> : null}
      <ActionRow icon={Activity} label="诊断与余量" onPress={onDiagnose} disabled={Boolean(busyAction)} />
      <ActionRow icon={Pencil} label="编辑" onPress={onEdit} disabled={Boolean(busyAction)} />
      <ActionRow icon={Boxes} label="查看可用模型" onPress={onModels} disabled={Boolean(busyAction)} />
      <ActionRow icon={Clock3} label="定时预热" onPress={onWarmup} disabled={Boolean(busyAction)} />
      <ActionRow icon={Bot} label="插件自动化" onPress={onAutomation} disabled={Boolean(busyAction)} />
      {dynamicActions.map((action, index) => { const id = stringValue(action.id ?? action.key) || String(index); return <ActionRow key={id} icon={Zap} label={localizedText(action.label) || id} busy={busyAction === `dynamic:${id}`} disabled={Boolean(busyAction) && busyAction !== `dynamic:${id}`} onPress={() => onDynamicAction(action)} />; })}
      <ActionRow icon={Power} label={rawDisabled ? '启用' : '禁用'} onPress={onToggle} busy={busyAction === 'toggle'} disabled={Boolean(busyAction) && busyAction !== 'toggle'} />
      <ActionRow icon={Download} label="导出" onPress={onExport} busy={busyAction === 'export'} disabled={Boolean(busyAction) && busyAction !== 'export'} />
      <ActionRow icon={Trash2} label="删除" onPress={onDelete} busy={busyAction === 'delete'} disabled={Boolean(busyAction) && busyAction !== 'delete'} danger />
    </ScrollView>
  </SheetFrame>;
}

function AccountInput({ label, value, onChangeText, placeholder, numeric = false, secure = false }: { label: string; value: string; onChangeText: (value: string) => void; placeholder?: string; numeric?: boolean; secure?: boolean }) {
  const colors = useAppTheme();
  const [visible, setVisible] = useState(false);
  return <View style={{ gap: 6 }}>
    <Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>{label}</Text>
    <View style={{ minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center' }}>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.placeholder} keyboardType={numeric ? 'number-pad' : 'default'} autoCapitalize="none" autoCorrect={false} secureTextEntry={secure && !visible} style={{ flex: 1, minHeight: 42, color: colors.text, paddingHorizontal: 11, fontSize: 11 }} />
      {secure ? <Pressable accessibilityLabel={visible ? '隐藏凭据' : '显示凭据'} onPress={() => setVisible((current) => !current)} style={{ width: 40, height: 42, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }}>{visible ? '隐藏' : '显示'}</Text></Pressable> : null}
    </View>
  </View>;
}

function emptyAccountDraft(): AccountDraft {
  return { label: '', priority: '0', concurrencyLimit: '', status: 'active', egressSelector: '', wsEnabled: false, credentials: {} };
}

function draftFromAccount(item: ApiRecord, proxies: ApiRecord[], proxiesLoaded: boolean, fields = accountCredentialFields(item)): AccountDraft {
  const credentials = Object.fromEntries(fields.map((field) => [field.key, '']));
  return {
    label: stringValue(item.label),
    priority: String(Number(item.priority ?? 0) || 0),
    concurrencyLimit: Number(item.concurrency_limit ?? 0) > 0 ? String(Number(item.concurrency_limit)) : '',
    status: stringValue(item.status) || 'active',
    egressSelector: accountEgress(item, proxies, proxiesLoaded).id,
    wsEnabled: Boolean(item.ws_enabled),
    credentials,
  };
}

function accountEditPatch(item: ApiRecord, draft: AccountDraft, proxies: ApiRecord[], proxiesLoaded: boolean) {
  const patch: ApiRecord = {};
  const label = draft.label.trim();
  if (label !== stringValue(item.label)) patch.label = label;
  const priority = Number(draft.priority);
  if (Number.isFinite(priority) && priority !== Number(item.priority ?? 0)) patch.priority = priority;
  const concurrencyLimit = draft.concurrencyLimit.trim() === '' ? 0 : Number(draft.concurrencyLimit);
  if (Number.isInteger(concurrencyLimit) && concurrencyLimit >= 0 && concurrencyLimit <= maxAccountConcurrency && concurrencyLimit !== Number(item.concurrency_limit ?? 0)) patch.concurrency_limit = concurrencyLimit;
  const rawStatus = stringValue(item.status);
  if ((rawStatus === 'active' || rawStatus === 'disabled') && draft.status !== rawStatus) patch.status = draft.status;
  const egress = accountEgress(item, proxies, proxiesLoaded);
  if (!egress.advanced && draft.egressSelector !== egress.id) patch.egress_selector = draft.egressSelector;
  if (draft.wsEnabled !== Boolean(item.ws_enabled)) patch.ws_enabled = draft.wsEnabled;
  const providerData = Object.fromEntries(Object.entries(draft.credentials).map(([key, value]) => [key, value.trim()]).filter(([, value]) => Boolean(value)));
  if (Object.keys(providerData).length) patch.provider_data = providerData;
  return patch;
}

function stickyProxyOwners(accounts: ApiRecord[], proxies: ApiRecord[]) {
  const sticky = new Set(proxies.filter((proxy) => proxy.sticky).map((proxy) => stringValue(proxy.id)).filter(Boolean));
  const owners: Record<string, string> = {};
  for (const account of [...accounts].sort((left, right) => accountId(left).localeCompare(accountId(right)))) {
    const selector = stringValue(account.egress_selector);
    const selectors = selector
      ? selector.split(',').map((value) => value.trim()).filter((value) => value && !value.startsWith('region:'))
      : [stringValue(account.proxy_id)].filter(Boolean);
    for (const proxyId of selectors) {
      if (sticky.has(proxyId) && !owners[proxyId]) owners[proxyId] = accountId(account);
    }
  }
  return owners;
}

function AccountEditSheet({ account, providerAccount, accounts, proxies, proxiesLoaded, onClose, onSaved, onActions }: { account?: ApiRecord; providerAccount?: ApiRecord; accounts: ApiRecord[]; proxies: ApiRecord[]; proxiesLoaded: boolean; onClose: () => void; onSaved: () => void; onActions: () => void }) {
  const colors = useAppTheme();
  const [draft, setDraft] = useState<AccountDraft>(emptyAccountDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const key = account ? accountId(account) : '';
  const fields = account ? accountCredentialFields(account, providerAccount) : [];
  const fieldsKey = fields.map((field) => field.key).join('\0');
  const supportsWebSocket = !providerAccount || arrayFrom(providerAccount, ['controls']).some((control) => stringValue(control.key) === 'ws_enabled');
  const proxyOwners = useMemo(() => stickyProxyOwners(accounts, proxies), [accounts, proxies]);

  useEffect(() => {
    setDraft(account ? draftFromAccount(account, proxies, proxiesLoaded, fields) : emptyAccountDraft());
    setError('');
  }, [fieldsKey, key]);

  if (!account) return <SheetFrame visible={false} onClose={onClose}><View /></SheetFrame>;
  const provider = accountProvider(account);
  const egress = accountEgress(account, proxies, proxiesLoaded);
  const rawStatus = stringValue(account.status);
  const editableStatus = rawStatus === 'active' || rawStatus === 'disabled';
  const priorityValid = draft.priority.trim() !== '' && Number.isFinite(Number(draft.priority));
  const concurrencyLimit = draft.concurrencyLimit.trim() === '' ? 0 : Number(draft.concurrencyLimit);
  const concurrencyValid = Number.isInteger(concurrencyLimit) && concurrencyLimit >= 0 && concurrencyLimit <= maxAccountConcurrency;

  async function save() {
    if (!account || !priorityValid || !concurrencyValid || saving) return;
    setSaving(true);
    setError('');
    try {
      const patch = accountEditPatch(account, draft, proxies, proxiesLoaded);
      if (Object.keys(patch).length) {
        await apiJson(`/admin/accounts/${encodeURIComponent(accountId(account))}`, { method: 'PUT', body: JSON.stringify(patch) });
        onSaved();
        Alert.alert('已保存', '账号配置已更新。');
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return <SheetFrame visible onClose={onClose} maxHeight="92%">
    <SheetHeader title="编辑上游账号" subtitle={`${accountIdentity(account).primary} · ${provider.label}`} onClose={onClose} />
    <ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 11, paddingBottom: 4 }}>
      <AccountInput label="账号标签" value={draft.label} onChangeText={(label) => setDraft((current) => ({ ...current, label }))} placeholder={accountIdentity(account).primary} />
      <AccountInput label="优先级" value={draft.priority} onChangeText={(priority) => setDraft((current) => ({ ...current, priority }))} numeric />
      <View style={{ flexDirection: 'row', gap: 6 }}>{[20, 0, -10].map((priority) => <Pressable key={priority} onPress={() => setDraft((current) => ({ ...current, priority: String(priority) }))} style={{ flex: 1, minHeight: 34, borderRadius: 10, backgroundColor: Number(draft.priority) === priority ? colors.primarySoft : colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: Number(draft.priority) === priority ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '800' }}>P{priority}</Text></Pressable>)}</View>
      {!priorityValid ? <Text style={{ color: colors.danger, fontSize: 11 }}>优先级必须是数字</Text> : null}
      <AccountInput label="并发上限" value={draft.concurrencyLimit} onChangeText={(concurrencyLimit) => setDraft((current) => ({ ...current, concurrencyLimit }))} placeholder="留空或 0 跟随全局默认" numeric />
      {!concurrencyValid ? <Text style={{ color: colors.danger, fontSize: 11 }}>并发上限必须是 0–{maxAccountConcurrency} 的整数</Text> : null}
      <View style={{ gap: 6 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>状态</Text>{editableStatus ? <View style={{ flexDirection: 'row', gap: 4, padding: 4, borderRadius: 12, backgroundColor: colors.mutedCard }}>{([['active', '启用'], ['disabled', '禁用']] as const).map(([status, label]) => <Pressable key={status} onPress={() => setDraft((current) => ({ ...current, status }))} style={{ flex: 1, minHeight: 38, borderRadius: 9, backgroundColor: draft.status === status ? colors.card : 'transparent', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: draft.status === status ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>{label}</Text></Pressable>)}</View> : <View style={{ minHeight: 42, borderRadius: 12, backgroundColor: colors.mutedCard, paddingHorizontal: 11, justifyContent: 'center' }}><Text style={{ color: colors.subtext, fontSize: 11 }}>{accountStatusLabels[accountStatus(account)]} · 系统维护状态</Text></View>}</View>
      <View style={{ gap: 7 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>出口代理</Text>{egress.advanced ? <View style={{ minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.mutedCard, paddingHorizontal: 11, justifyContent: 'center' }}><Text selectable numberOfLines={2} style={{ color: colors.subtext, fontFamily: 'monospace', fontSize: 11 }}>{stringValue(account.egress_selector)}</Text></View> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        <Pressable onPress={() => setDraft((current) => ({ ...current, egressSelector: '' }))} style={{ minHeight: 36, paddingHorizontal: 11, borderRadius: 11, borderWidth: 1, borderColor: draft.egressSelector === '' ? colors.primary : colors.border, backgroundColor: draft.egressSelector === '' ? colors.primarySoft : colors.card, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: draft.egressSelector === '' ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>直连</Text></Pressable>
        {proxies.map((proxy, index) => { const id = stringValue(proxy.id) || String(index); const selected = draft.egressSelector === id; const name = stringValue(proxy.name) || stringValue(proxy.host) || id; const ownerId = proxyOwners[id]; const ownedByOther = Boolean(ownerId && ownerId !== accountId(account)); const owner = ownedByOther ? accounts.find((item) => accountId(item) === ownerId) : undefined; return <Pressable key={id} disabled={ownedByOther} onPress={() => setDraft((current) => ({ ...current, egressSelector: id }))} style={{ minHeight: 36, maxWidth: '100%', paddingHorizontal: 11, borderRadius: 11, borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primarySoft : colors.card, alignItems: 'center', justifyContent: 'center', opacity: ownedByOther ? 0.45 : 1 }}><Text numberOfLines={1} style={{ color: selected ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>{name}{proxy.enabled === false ? '（禁用）' : ''}{proxy.sticky ? ' · 专属' : ''}{owner ? ` · 已分配给 ${accountIdentity(owner).primary}` : ''}</Text></Pressable>; })}
        {draft.egressSelector && !proxies.some((proxy) => stringValue(proxy.id) === draft.egressSelector) ? <View style={{ minHeight: 36, paddingHorizontal: 11, borderRadius: 11, backgroundColor: colors.warningBg, justifyContent: 'center' }}><Text style={{ color: colors.warning, fontSize: 11, fontWeight: '700' }}>{draft.egressSelector}（未找到）</Text></View> : null}
      </View>}</View>
      {supportsWebSocket ? <View style={{ minHeight: 46, borderTopWidth: 1, borderTopColor: colors.rowBorder, flexDirection: 'row', alignItems: 'center', gap: 9 }}><Wifi color={draft.wsEnabled ? colors.primary : colors.subtext} size={15} /><View style={{ flex: 1, gap: 2 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>WebSocket</Text><Text style={{ color: colors.subtext, fontSize: 11 }}>允许该账号承载 WebSocket 会话</Text></View><AppSwitch accessibilityLabel="WebSocket" value={draft.wsEnabled} onValueChange={(wsEnabled) => setDraft((current) => ({ ...current, wsEnabled }))} /></View> : null}
      {fields.map((field) => <AccountInput key={field.key} label={field.label} value={draft.credentials[field.key] ?? ''} onChangeText={(value) => setDraft((current) => ({ ...current, credentials: { ...current.credentials, [field.key]: value } }))} placeholder={field.placeholder} secure={field.secure} />)}
      {fields.length ? <Text style={{ color: colors.subtext, fontSize: 11, lineHeight: 14 }}>凭据留空时保持现有值不变。</Text> : null}
    </ScrollView>
    {error ? <Text style={{ color: colors.danger, fontSize: 11 }}>{error}</Text> : null}
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <CompactButton icon={SlidersHorizontal} label="账号操作" disabled={saving} onPress={onActions} />
      <Pressable disabled={!priorityValid || !concurrencyValid || saving} onPress={() => void save()} style={{ flexGrow: 2, flexBasis: 160, minWidth: 0, minHeight: 48, borderRadius: 13, backgroundColor: priorityValid && concurrencyValid && !saving ? colors.primary : colors.disabled, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }}>{saving ? <ActivityIndicator color="#fff" /> : <Save color="#fff" size={16} />}<Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{saving ? '保存中...' : '保存账号'}</Text></Pressable>
    </View>
  </SheetFrame>;
}

function AccountModelsSheet({ account, onClose }: { account?: ApiRecord; onClose: () => void }) {
  const colors = useAppTheme();
  const { height } = useWindowDimensions();
  const [search, setSearch] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [testProgress, setTestProgress] = useState<ModelTestProgress>();
  const [testAllError, setTestAllError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [testStates, setTestStates] = useState<Record<string, ModelTestState>>({});
  const [modelFilter, setModelFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [savingAllowlist, setSavingAllowlist] = useState(false);
  const activeTestRef = useRef(false);
  const testControllerRef = useRef<AbortController | undefined>(undefined);
  const testRunRef = useRef(0);
  const id = account ? accountId(account) : '';
  const query = useQuery({
    queryKey: ['admin', 'accounts', 'models', id],
    queryFn: ({ signal }) => apiJson<unknown>(`/admin/accounts/${encodeURIComponent(id)}/models`, { signal }),
    enabled: Boolean(id),
    staleTime: 0,
    retry: 0,
  });

  useEffect(() => {
    testRunRef.current += 1;
    testControllerRef.current?.abort();
    testControllerRef.current = undefined;
    activeTestRef.current = false;
    setSearch('');
    setManualModel('');
    setTesting(new Set());
    setTestingAll(false);
    setTestProgress(undefined);
    setTestAllError('');
    setTestStates({});
    setModelFilter('all');
    setAllowlist([]);
    setSavingAllowlist(false);
    return () => {
      testRunRef.current += 1;
      testControllerRef.current?.abort();
      testControllerRef.current = undefined;
      activeTestRef.current = false;
    };
  }, [id]);

  const provider = account ? stringValue(account.provider) : '';
  const envelope = findModelEnvelope(query.data);
  const supported = envelope?.supported !== false;
  const models = useMemo(() => normalizeAvailableModels(query.data, provider), [provider, query.data]);
  const serverAllowed = Array.isArray(envelope?.allowed)
    ? envelope.allowed.map(String).filter(Boolean)
    : Array.isArray(account?.model_allowlist) ? account.model_allowlist.map(String).filter(Boolean) : [];
  const serverAllowedKey = serverAllowed.join('\0');

  useEffect(() => {
    setAllowlist(serverAllowed);
  }, [id, serverAllowedKey]);

  const allModelIds = useMemo(() => [...new Set(models.map(availableModelId).filter(Boolean))], [models]);
  const allowedSet = useMemo(() => new Set(allowlist.map((value) => value.toLowerCase())), [allowlist]);
  const isAllowed = (model: string) => allowlist.length === 0 || allowedSet.has(model.toLowerCase());
  const enabledCount = allowlist.length === 0 ? allModelIds.length : allModelIds.filter(isAllowed).length;
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return models.filter((item) => {
      const model = availableModelId(item);
      const enabled = allowlist.length === 0 || allowedSet.has(model.toLowerCase());
      if (modelFilter === 'enabled' && !enabled) return false;
      if (modelFilter === 'disabled' && enabled) return false;
      return !keyword || `${model} ${item.display_name ?? ''} ${item.label ?? ''} ${item.provider ?? ''}`.toLowerCase().includes(keyword);
    });
  }, [allowlist.length, allowedSet, modelFilter, models, search]);

  async function saveAllowlist(next: string[]) {
    if (!id || savingAllowlist) return;
    const previous = allowlist;
    setAllowlist(next);
    setSavingAllowlist(true);
    try {
      await apiJson(`/admin/accounts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ model_allowlist: next }) });
      await query.refetch();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
    } catch (error) {
      setAllowlist(previous);
      Alert.alert('模型配置保存失败', modelTestError(error));
    } finally {
      setSavingAllowlist(false);
    }
  }

  function toggleModel(model: string) {
    if (savingAllowlist) return;
    const enabled = isAllowed(model);
    if (enabled) {
      const current = allowlist.length ? allowlist : allModelIds;
      if (current.length <= 1) {
        Alert.alert('至少保留一个模型', '账号必须至少启用一个可用模型。');
        return;
      }
      void saveAllowlist(current.filter((value) => value.toLowerCase() !== model.toLowerCase()));
      return;
    }
    const next = [...allowlist, model];
    const coversAll = allModelIds.every((value) => next.some((candidate) => candidate.toLowerCase() === value.toLowerCase()));
    void saveAllowlist(coversAll ? [] : next);
  }

  async function testModel(idToTest: string) {
    const model = idToTest.trim();
    if (!id || !model || activeTestRef.current) return;
    const run = ++testRunRef.current;
    const controller = new AbortController();
    activeTestRef.current = true;
    testControllerRef.current = controller;
    setTestAllError('');
    setTestProgress(undefined);
    setTesting(new Set([model]));
    try {
      const result = await requestModelTest(id, model, controller.signal);
      if (testRunRef.current === run) setTestStates((current) => ({ ...current, [model]: result }));
    } catch (error) {
      if (!controller.signal.aborted && testRunRef.current === run) {
        setTestStates((current) => ({ ...current, [model]: { ok: false, message: modelTestError(error), testedAt: modelTestTime() } }));
      }
    } finally {
      if (testRunRef.current === run) {
        activeTestRef.current = false;
        testControllerRef.current = undefined;
        setTesting(new Set());
      }
    }
  }

  async function testAll() {
    const queue = [...new Set(models.map(availableModelId).filter((model) => Boolean(model)))];
    if (!id || !queue.length || activeTestRef.current) return;
    const run = ++testRunRef.current;
    const controller = new AbortController();
    activeTestRef.current = true;
    testControllerRef.current = controller;
    setTestingAll(true);
    setTestAllError('');
    setTestProgress({ completed: 0, total: queue.length });
    try {
      for (let index = 0; index < queue.length; index += 1) {
        if (controller.signal.aborted || testRunRef.current !== run) return;
        const model = queue[index];
        setTesting(new Set([model]));
        const result = await requestModelTest(id, model, controller.signal);
        if (controller.signal.aborted || testRunRef.current !== run) return;
        setTestStates((current) => ({ ...current, [model]: result }));
        setTestProgress({ completed: index + 1, total: queue.length });
      }
    } catch (error) {
      if (!controller.signal.aborted && testRunRef.current === run) setTestAllError(modelTestError(error));
    } finally {
      if (testRunRef.current === run) {
        activeTestRef.current = false;
        testControllerRef.current = undefined;
        setTesting(new Set());
        setTestingAll(false);
      }
    }
  }

  function closeSheet() {
    testRunRef.current += 1;
    testControllerRef.current?.abort();
    testControllerRef.current = undefined;
    activeTestRef.current = false;
    setTesting(new Set());
    setTestingAll(false);
    setTestProgress(undefined);
    onClose();
  }

  async function copyModel(model: string) {
    await Clipboard.setStringAsync(model);
    setCopiedId(model);
    setTimeout(() => setCopiedId((current) => current === model ? '' : current), 1600);
  }

  const identity = account ? accountIdentity(account) : { primary: '', secondary: '' };
  const manualState = testStates[manualModel.trim()];
  const testsBusy = testingAll || testing.size > 0;
  const manualTestEnabled = Boolean(manualModel.trim()) && !testsBusy;
  const testAllLabel = testingAll && testProgress ? `${testProgress.completed}/${testProgress.total}` : '测试全部';
  return <SheetFrame visible={Boolean(account)} onClose={closeSheet} maxHeight="90%">
    <SheetHeader title="可用模型" subtitle={account ? `${identity.primary} · ${accountProvider(account).label}` : undefined} onClose={closeSheet} />
    <View style={{ height: Math.min(640, Math.max(330, height * 0.7)), gap: 10 }}>
      {query.isLoading ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 9 }}><ActivityIndicator color={colors.primary} /><Text style={{ color: colors.subtext, fontSize: 11 }}>正在读取账号模型...</Text></View> : query.error ? <ErrorState message={query.error.message} retry={() => query.refetch()} /> : !supported ? <View style={{ gap: 12 }}>
        <View style={{ borderRadius: 14, backgroundColor: colors.mutedCard, padding: 12, gap: 4 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '800' }}>该提供商不支持模型目录</Text><Text style={{ color: colors.subtext, fontSize: 11, lineHeight: 15 }}>输入模型 ID 可直接检查该账号是否可用。</Text></View>
        <View style={{ flexDirection: 'row', gap: 8 }}><TextInput value={manualModel} onChangeText={setManualModel} placeholder="输入模型 ID" placeholderTextColor={colors.placeholder} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, color: colors.text, paddingHorizontal: 11, fontSize: 11, fontFamily: 'monospace' }} /><Pressable disabled={!manualTestEnabled} onPress={() => void testModel(manualModel)} style={{ width: 46, height: 44, borderRadius: 12, backgroundColor: manualTestEnabled || testing.has(manualModel.trim()) ? colors.primary : colors.disabled, alignItems: 'center', justifyContent: 'center' }}>{testing.has(manualModel.trim()) ? <ActivityIndicator color="#fff" size="small" /> : <Play color="#fff" size={16} />}</Pressable></View>
        {manualState ? <Text style={{ color: manualState.ok ? colors.success : colors.danger, fontSize: 11, lineHeight: 16 }}>{manualState.message} · {manualState.testedAt}</Text> : null}
      </View> : <>
        <View style={{ minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text style={{ flex: 1, color: colors.text, fontSize: 11, fontWeight: '800' }}>{enabledCount} / {models.length} 已启用</Text><Pressable disabled={!models.length || testsBusy} onPress={() => void testAll()} style={{ minHeight: 38, paddingHorizontal: 10, borderRadius: 11, backgroundColor: colors.primarySoft, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: models.length ? 1 : 0.45 }}>{testingAll ? <ActivityIndicator color={colors.primary} size="small" /> : <RefreshCw color={colors.primary} size={14} />}<Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }}>{testAllLabel}</Text></Pressable></View>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {([['all', `全部 ${models.length}`], ['enabled', `已启用 ${enabledCount}`], ['disabled', `已停用 ${models.length - enabledCount}`]] as const).map(([value, label]) => <Pressable key={value} onPress={() => setModelFilter(value)} style={{ flex: 1, minHeight: 34, borderRadius: 10, backgroundColor: modelFilter === value ? colors.primarySoft : colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}><Text numberOfLines={1} style={{ color: modelFilter === value ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>{label}</Text></Pressable>)}
        </View>
        <View style={{ flexDirection: 'row', gap: 6 }}><CompactButton icon={Check} label="全部启用" disabled={savingAllowlist || allowlist.length === 0} onPress={() => void saveAllowlist([])} /><CompactButton icon={Power} label="停用其余" disabled={savingAllowlist || allModelIds.length <= 1} onPress={() => void saveAllowlist(allModelIds.slice(0, 1))} /></View>
        {testAllError ? <Text numberOfLines={2} style={{ color: colors.danger, fontSize: 11, lineHeight: 14 }}>批量测试已中断：{testAllError}</Text> : null}
        <SearchField value={search} onChangeText={setSearch} placeholder="搜索模型" />
        {account?.models_probe_error ? <Text numberOfLines={2} style={{ color: colors.warning, fontSize: 11, lineHeight: 14 }}>目录探测：{String(account.models_probe_error)}</Text> : null}
        <FlatList
          data={filtered}
          bounces={false}
          alwaysBounceVertical={false}
          overScrollMode="never"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item, index) => `${availableModelId(item)}-${index}`}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: filtered.length ? 0 : 1, paddingBottom: 2 }}
          ListEmptyComponent={<EmptyState embedded icon={Boxes} message={models.length ? '没有匹配的模型' : '该账号暂无可用模型'} />}
          renderItem={({ item }) => {
            const model = availableModelId(item);
            const displayName = stringValue(item.display_name ?? item.label ?? item.title);
            const context = modelContext(item);
            const testState = testStates[model];
            const probeError = stringValue(item.probe_error ?? item.last_error);
            const probeTime = formatTimestamp(item.last_probe_at ?? item.probed_at ?? item.last_tested_at);
            const message = testState?.message || probeError;
            const ok = testState ? testState.ok : !probeError;
            const enabled = isAllowed(model);
            return <View style={{ minHeight: 70, borderBottomWidth: 1, borderBottomColor: colors.rowBorder, paddingVertical: 10, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AppSwitch accessibilityLabel={`启用 ${model}`} value={enabled} disabled={savingAllowlist} onValueChange={() => toggleModel(model)} /><View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text selectable numberOfLines={2} style={{ color: enabled ? colors.text : colors.subtext, fontSize: 11, lineHeight: 16, fontWeight: '800', fontFamily: 'monospace' }}>{model || '未命名模型'}</Text>{displayName || context ? <Text numberOfLines={1} style={{ color: colors.subtext, fontSize: 11 }}>{[displayName !== model ? displayName : '', context].filter(Boolean).join(' · ')}</Text> : null}</View><Pressable accessibilityLabel="复制模型 ID" onPress={() => void copyModel(model)} style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}>{copiedId === model ? <Check color={colors.success} size={15} /> : <Copy color={colors.subtext} size={15} />}</Pressable><Pressable accessibilityLabel="测试模型" disabled={testsBusy} onPress={() => void testModel(model)} style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', opacity: testsBusy && !testing.has(model) ? 0.45 : 1 }}>{testing.has(model) ? <ActivityIndicator color={colors.primary} size="small" /> : <Play color={colors.primary} size={15} />}</Pressable></View>
              {message || probeTime ? <Text numberOfLines={2} style={{ marginLeft: 42, color: ok ? colors.success : colors.danger, fontSize: 11, lineHeight: 14 }}>{message || '上次探测成功'}{testState?.testedAt ? ` · ${testState.testedAt}` : probeTime ? ` · ${probeTime}` : ''}</Text> : null}
            </View>;
          }}
        />
      </>}
    </View>
  </SheetFrame>;
}

function warmupDraftFrom(item: ApiRecord): WarmupDraft {
  const nested = recordValue(item.warmup);
  const timesValue = item.warmup_times ?? nested.times;
  const times = Array.isArray(timesValue) ? timesValue.map(String).filter(Boolean) : [];
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; } catch { timezone = 'Asia/Shanghai'; }
  return {
    enabled: Boolean(item.warmup_enabled ?? nested.enabled),
    times: times.length ? times : ['07:00'],
    timezone: stringValue(item.warmup_timezone ?? nested.timezone) || timezone,
    model: stringValue(item.warmup_model ?? nested.model),
  };
}

function WarmupSheet({ account, onClose, onSaved }: { account?: ApiRecord; onClose: () => void; onSaved: () => void }) {
  const colors = useAppTheme();
  const id = account ? accountId(account) : '';
  const [draft, setDraft] = useState<WarmupDraft>({ enabled: false, times: ['07:00'], timezone: 'Asia/Shanghai', model: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const modelsQuery = useQuery({ queryKey: ['admin', 'accounts', 'warmup-models', id], queryFn: ({ signal }) => apiJson<unknown>(`/admin/accounts/${encodeURIComponent(id)}/models`, { signal }), enabled: Boolean(id), retry: 0 });
  const models = useMemo(() => normalizeAvailableModels(modelsQuery.data, account ? stringValue(account.provider) : ''), [account, modelsQuery.data]);
  const suggestions = models.filter((item) => !draft.model.trim() || availableModelId(item).toLowerCase().includes(draft.model.trim().toLowerCase())).slice(0, 8);
  const timeValid = draft.times.length > 0 && draft.times.every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
  const canSave = !saving && (!draft.enabled || timeValid);
  const timezonePresets = [...new Set(['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'America/Los_Angeles', draft.timezone].filter(Boolean))];

  useEffect(() => {
    if (account) setDraft(warmupDraftFrom(account));
    setError('');
  }, [id]);

  async function save() {
    if (!account || !canSave) return;
    setSaving(true);
    setError('');
    try {
      await apiJson(`/admin/accounts/${encodeURIComponent(accountId(account))}`, { method: 'PUT', body: JSON.stringify({ warmup: { enabled: draft.enabled, times: [...new Set(draft.times)].sort(), timezone: draft.timezone.trim(), model: draft.model.trim() } }) });
      onSaved();
      onClose();
      Alert.alert('已保存', '定时预热配置已更新。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return <SheetFrame visible={Boolean(account)} onClose={onClose} maxHeight="92%">
    <SheetHeader title="定时预热" subtitle={account ? accountIdentity(account).primary : undefined} onClose={onClose} />
    <ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 12, paddingBottom: 4 }}>
      <View style={{ minHeight: 50, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 9 }}><Clock3 color={draft.enabled ? colors.primary : colors.subtext} size={16} /><View style={{ flex: 1, gap: 2 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '800' }}>启用定时预热</Text><Text style={{ color: colors.subtext, fontSize: 11 }}>按设定时间预先调用上游账号</Text></View><AppSwitch accessibilityLabel="启用定时预热" value={draft.enabled} onValueChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} /></View>
      <View style={{ gap: 7 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>执行时间</Text>{draft.times.map((time, index) => <View key={index} style={{ flexDirection: 'row', gap: 7 }}><TextInput value={time} onChangeText={(value) => setDraft((current) => ({ ...current, times: current.times.map((entry, entryIndex) => entryIndex === index ? value : entry) }))} placeholder="07:00" placeholderTextColor={colors.placeholder} keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'} style={{ flex: 1, minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? colors.border : colors.danger, backgroundColor: colors.card, color: colors.text, paddingHorizontal: 11, fontSize: 11, fontFamily: 'monospace' }} /><Pressable accessibilityLabel="移除时间" disabled={draft.times.length <= 1} onPress={() => setDraft((current) => ({ ...current, times: current.times.filter((_, entryIndex) => entryIndex !== index) }))} style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center', opacity: draft.times.length <= 1 ? 0.4 : 1 }}><Trash2 color={colors.subtext} size={15} /></Pressable></View>)}<Pressable disabled={draft.times.length >= 8} onPress={() => setDraft((current) => ({ ...current, times: [...current.times, ''] }))} style={{ alignSelf: 'flex-start', minHeight: 36, paddingHorizontal: 10, borderRadius: 11, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 5 }}><Plus color={colors.primary} size={14} /><Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }}>添加时间</Text></Pressable></View>
      <AccountInput label="时区" value={draft.timezone} onChangeText={(timezone) => setDraft((current) => ({ ...current, timezone }))} placeholder="留空跟随服务器" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{timezonePresets.map((timezone) => <Pressable key={timezone} onPress={() => setDraft((current) => ({ ...current, timezone }))} style={{ minHeight: 32, paddingHorizontal: 9, borderRadius: 10, backgroundColor: draft.timezone === timezone ? colors.primarySoft : colors.mutedCard, justifyContent: 'center' }}><Text style={{ color: draft.timezone === timezone ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>{timezone}</Text></Pressable>)}</View>
      <AccountInput label="预热模型" value={draft.model} onChangeText={(model) => setDraft((current) => ({ ...current, model }))} placeholder="留空自动选择" />
      {suggestions.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{suggestions.map((item) => { const model = availableModelId(item); return <Pressable key={model} onPress={() => setDraft((current) => ({ ...current, model }))} style={{ maxWidth: '100%', minHeight: 32, paddingHorizontal: 9, borderRadius: 10, backgroundColor: colors.mutedCard, justifyContent: 'center' }}><Text numberOfLines={1} style={{ color: colors.subtext, fontSize: 11, fontFamily: 'monospace' }}>{model}</Text></Pressable>; })}</View> : null}
      {account?.warmup_last_at ? <View style={{ borderTopWidth: 1, borderTopColor: colors.rowBorder, paddingTop: 9, gap: 4 }}><Text style={{ color: colors.subtext, fontSize: 11 }}>上次执行 · {formatTimestamp(account.warmup_last_at)}</Text>{account.warmup_last_error ? <Text style={{ color: colors.warning, fontSize: 11, lineHeight: 14 }}>{String(account.warmup_last_error)}</Text> : null}</View> : null}
    </ScrollView>
    {draft.enabled && !timeValid ? <Text style={{ color: colors.danger, fontSize: 11 }}>请填写有效时间，格式为 HH:mm。</Text> : null}
    {error ? <Text style={{ color: colors.danger, fontSize: 11 }}>{error}</Text> : null}
    <Pressable disabled={!canSave} onPress={() => void save()} style={{ minHeight: 48, borderRadius: 13, backgroundColor: canSave ? colors.primary : colors.disabled, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }}>{saving ? <ActivityIndicator color="#fff" /> : <Save color="#fff" size={16} />}<Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{saving ? '保存中...' : '保存预热配置'}</Text></Pressable>
  </SheetFrame>;
}

function localizedText(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  const record = recordValue(value);
  return stringValue(record['zh-CN'] ?? record.zh ?? record.en ?? Object.values(record).find((entry) => typeof entry === 'string'));
}

function AutomationRunList({ accountId: id, hookId }: { accountId: string; hookId: string }) {
  const colors = useAppTheme();
  const runs = useQuery({
    queryKey: ['admin', 'accounts', 'automation-runs', id, hookId],
    queryFn: ({ signal }) => apiJson<unknown>(`/admin/accounts/${encodeURIComponent(id)}/plugin-schedule/${encodeURIComponent(hookId)}/runs`, { signal, query: { limit: 20 } }),
  });
  const items = arrayFrom(runs.data, ['runs', 'items']);
  if (runs.isLoading) return <ActivityIndicator color={colors.primary} size="small" style={{ marginVertical: 8 }} />;
  if (runs.error) return <Text style={{ color: colors.danger, fontSize: 11 }}>{runs.error.message}</Text>;
  if (!items.length) return <Text style={{ color: colors.subtext, fontSize: 11 }}>暂无执行记录</Text>;
  return <View style={{ gap: 5 }}>{items.map((item, index) => {
    const status = stringValue(item.status) || 'unknown';
    const ok = status === 'ok' || status === 'success';
    return <View key={stringValue(item.id) || String(index)} style={{ borderTopWidth: 1, borderTopColor: colors.rowBorder, paddingTop: 6, gap: 2 }}><View style={{ flexDirection: 'row', gap: 7 }}><Text style={{ flex: 1, color: colors.subtext, fontSize: 11 }}>{formatTimestamp(item.finished_at ?? item.started_at)}</Text><Text style={{ color: ok ? colors.success : status === 'error' ? colors.danger : colors.subtext, fontSize: 11, fontWeight: '800' }}>{status}</Text></View>{item.summary ? <Text numberOfLines={3} style={{ color: colors.text, fontSize: 11, lineHeight: 15 }}>{String(item.summary)}</Text> : null}{item.error ? <Text numberOfLines={3} style={{ color: colors.danger, fontSize: 11, lineHeight: 15 }}>{String(item.error)}</Text> : null}</View>;
  })}</View>;
}

function AutomationSheet({ account, onClose }: { account?: ApiRecord; onClose: () => void }) {
  const colors = useAppTheme();
  const id = account ? accountId(account) : '';
  const [busyHook, setBusyHook] = useState('');
  const [expandedHook, setExpandedHook] = useState('');
  const schedule = useQuery({
    queryKey: ['admin', 'accounts', 'automation', id],
    queryFn: ({ signal }) => apiJson<unknown>(`/admin/accounts/${encodeURIComponent(id)}/plugin-schedule`, { signal }),
    enabled: Boolean(id),
    retry: 0,
  });
  const hooks = arrayFrom(schedule.data, ['hooks', 'items']);

  async function toggle(hook: ApiRecord, enabled: boolean) {
    const hookId = stringValue(hook.hook_id ?? hook.id);
    const enabledBy = stringValue(hook.enabled_by);
    if (!hookId || !enabledBy || busyHook) return;
    setBusyHook(hookId);
    try {
      await apiJson(`/admin/accounts/${encodeURIComponent(id)}/plugin-settings`, { method: 'PUT', body: JSON.stringify({ values: { [enabledBy]: enabled } }) });
      await schedule.refetch();
    } catch (error) {
      Alert.alert('自动化设置失败', modelTestError(error));
    } finally {
      setBusyHook('');
    }
  }

  async function run(hook: ApiRecord) {
    const hookId = stringValue(hook.hook_id ?? hook.id);
    if (!hookId || busyHook) return;
    setBusyHook(hookId);
    try {
      const result = await apiJson<ApiRecord>(`/admin/accounts/${encodeURIComponent(id)}/plugin-schedule/${encodeURIComponent(hookId)}/run`, { method: 'POST', timeoutMs: 120000 });
      Alert.alert('执行完成', stringValue(result.message ?? result.summary) || `${localizedText(hook.label) || hookId} 已执行。`);
      await schedule.refetch();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'accounts', 'automation-runs', id, hookId] });
    } catch (error) {
      Alert.alert('立即运行失败', modelTestError(error));
    } finally {
      setBusyHook('');
    }
  }

  return <SheetFrame visible={Boolean(account)} onClose={onClose} maxHeight="92%">
    <SheetHeader title="插件自动化" subtitle={account ? accountIdentity(account).primary : undefined} onClose={onClose} />
    <ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
      {schedule.isLoading ? <View style={{ minHeight: 140, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View> : null}
      {schedule.error ? <ErrorState message={schedule.error.message} retry={() => schedule.refetch()} /> : null}
      {!schedule.isLoading && !schedule.error && !hooks.length ? <EmptyState embedded icon={Bot} message="该账号没有插件自动化任务" /> : null}
      {hooks.map((hook, index) => {
        const hookId = stringValue(hook.hook_id ?? hook.id) || String(index);
        const label = localizedText(hook.label) || ({ daily_checkin: '每日签到', rewards: '自动领取奖励', wallet: '钱包管家', tasks: '自动完成任务' } as Record<string, string>)[hookId] || hookId;
        const busy = busyHook === hookId;
        const expanded = expandedHook === hookId;
        const status = stringValue(hook.last_status);
        return <View key={hookId} style={{ borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 10, gap: 7 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}><Zap color={colors.primary} size={15} /></View><View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text numberOfLines={1} style={{ color: colors.text, fontSize: 11, fontWeight: '800' }}>{label}</Text><Text numberOfLines={2} style={{ color: colors.subtext, fontSize: 11 }}>{[stringValue(hook.schedule), status, hook.last_run_at ? `上次 ${formatTimestamp(hook.last_run_at)}` : '', hook.next_run_at ? `下次 ${formatTimestamp(hook.next_run_at)}` : ''].filter(Boolean).join(' · ')}</Text></View>{busy ? <ActivityIndicator color={colors.primary} size="small" /> : <AppSwitch accessibilityLabel={label} value={Boolean(hook.enabled)} disabled={!hook.enabled_by} onValueChange={(value) => void toggle(hook, value)} />}</View>
          {hook.last_error ? <Text numberOfLines={3} style={{ color: colors.danger, fontSize: 11, lineHeight: 15 }}>{String(hook.last_error)}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 7 }}><CompactButton icon={Play} label="立即运行" busy={busy} onPress={() => void run(hook)} /><CompactButton icon={History} label={expanded ? '收起记录' : '执行记录'} disabled={busy} onPress={() => setExpandedHook(expanded ? '' : hookId)} /></View>
          {expanded ? <AutomationRunList accountId={id} hookId={hookId} /> : null}
        </View>;
      })}
    </ScrollView>
  </SheetFrame>;
}

function ImportSheet({ visible, onClose, onImported }: { visible: boolean; onClose: () => void; onImported: () => void }) {
  const colors = useAppTheme();
  const [file, setFile] = useState<DocumentPickerAsset>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<unknown>();
  const [resultMode, setResultMode] = useState<'check' | 'import'>('check');

  useEffect(() => {
    if (!visible) {
      setFile(undefined);
      setError('');
      setResult(undefined);
    }
  }, [visible]);

  async function chooseFile() {
    const selection = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/csv', 'text/plain'], copyToCacheDirectory: true, multiple: false });
    if (!selection.canceled && selection.assets[0]) {
      setFile(selection.assets[0]);
      setResult(undefined);
      setError('');
    }
  }

  async function submit(dryRun: boolean) {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const payload = await apiJson<unknown>('/admin/accounts/import', { method: 'POST', body: documentMultipartBody(file), query: { dry_run: dryRun ? 1 : undefined }, timeoutMs: 120000 });
      setResult(payload);
      setResultMode(dryRun ? 'check' : 'import');
      if (!dryRun) onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文件导入失败');
    } finally {
      setBusy(false);
    }
  }

  return <SheetFrame visible={visible} onClose={onClose} maxHeight="90%">
    <SheetHeader title="导入账号文件" subtitle="JSON、CSV 或文本格式" onClose={onClose} />
    <Pressable disabled={busy} onPress={() => void chooseFile()} style={{ minHeight: 52, borderRadius: 13, borderWidth: 1, borderColor: file ? colors.success : colors.border, backgroundColor: colors.card, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 9 }}><FileUp color={file ? colors.success : colors.primary} size={17} /><View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text numberOfLines={1} style={{ color: file ? colors.text : colors.subtext, fontSize: 11, fontWeight: '700' }}>{file?.name ?? '选择账号文件'}</Text>{file?.size ? <Text style={{ color: colors.subtext, fontSize: 11 }}>{file.size} bytes</Text> : null}</View></Pressable>
    {file ? <View style={{ flexDirection: 'row', gap: 8 }}><CompactButton icon={SearchX} label="检查文件" busy={busy} onPress={() => void submit(true)} /><CompactButton icon={Upload} label="正式导入" primary busy={busy} onPress={() => void submit(false)} /></View> : null}
    {error ? <Text style={{ color: colors.danger, fontSize: 11 }}>{error}</Text> : null}
    {result !== undefined ? <View style={{ maxHeight: 280, gap: 7 }}><Text style={{ color: resultMode === 'import' ? colors.success : colors.primary, fontSize: 11, fontWeight: '800' }}>{resultMode === 'import' ? '导入完成' : '文件检查结果'}</Text><ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" style={{ flexGrow: 0 }}><StructuredDataView value={result} /></ScrollView></View> : null}
  </SheetFrame>;
}

function BulkSettingsSheet({ visible, count, proxies, busy, onClose, onApply }: { visible: boolean; count: number; proxies: ApiRecord[]; busy: boolean; onClose: () => void; onApply: (patch: ApiRecord) => void }) {
  const colors = useAppTheme();
  const [priority, setPriority] = useState('');
  const [egress, setEgress] = useState('__unchanged__');
  const [ws, setWs] = useState<'unchanged' | 'on' | 'off'>('unchanged');

  useEffect(() => {
    if (visible) {
      setPriority('');
      setEgress('__unchanged__');
      setWs('unchanged');
    }
  }, [visible]);

  const priorityNumber = priority.trim() === '' ? undefined : Number(priority);
  const valid = priorityNumber === undefined || Number.isFinite(priorityNumber);
  const patch: ApiRecord = {};
  if (priorityNumber !== undefined && valid) patch.priority = priorityNumber;
  if (egress !== '__unchanged__') patch.egress_selector = egress;
  if (ws !== 'unchanged') patch.ws_enabled = ws === 'on';
  const hasChanges = Object.keys(patch).length > 0;
  return <SheetFrame visible={visible} onClose={onClose} maxHeight="88%">
    <SheetHeader title={`批量配置 ${count} 个账号`} subtitle="只会更新已填写或已选择的项目" onClose={onClose} />
    <ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 12 }}>
      <AccountInput label="优先级" value={priority} onChangeText={setPriority} placeholder="留空保持不变" numeric />
      {!valid ? <Text style={{ color: colors.danger, fontSize: 11 }}>优先级必须是数字</Text> : null}
      <View style={{ gap: 7 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>出口代理</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {[{ id: '__unchanged__', label: '保持不变' }, { id: '', label: '默认网络路径' }, ...proxies.map((proxy, index) => ({ id: stringValue(proxy.id) || String(index), label: stringValue(proxy.name ?? proxy.host ?? proxy.id) }))].map((option) => <Pressable key={option.id || 'direct'} onPress={() => setEgress(option.id)} style={{ minHeight: 36, paddingHorizontal: 10, borderRadius: 10, backgroundColor: egress === option.id ? colors.primarySoft : colors.mutedCard, justifyContent: 'center' }}><Text style={{ color: egress === option.id ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>{option.label}</Text></Pressable>)}
      </View></View>
      <View style={{ gap: 7 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>WebSocket</Text><View style={{ flexDirection: 'row', gap: 5 }}>{([['unchanged', '保持不变'], ['on', '启用'], ['off', '停用']] as const).map(([value, label]) => <Pressable key={value} onPress={() => setWs(value)} style={{ flex: 1, minHeight: 38, borderRadius: 10, backgroundColor: ws === value ? colors.primarySoft : colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: ws === value ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>{label}</Text></Pressable>)}</View></View>
    </ScrollView>
    <Pressable disabled={!valid || !hasChanges || busy} onPress={() => onApply(patch)} style={{ minHeight: 48, borderRadius: 13, backgroundColor: valid && hasChanges && !busy ? colors.primary : colors.disabled, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }}>{busy ? <ActivityIndicator color="#fff" /> : <Save color="#fff" size={16} />}<Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>应用批量配置</Text></Pressable>
  </SheetFrame>;
}

function BulkWarmupSheet({ visible, count, busy, onClose, onApply }: { visible: boolean; count: number; busy: boolean; onClose: () => void; onApply: (patch: ApiRecord) => void }) {
  const colors = useAppTheme();
  const [enabled, setEnabled] = useState(true);
  const [times, setTimes] = useState(['07:00']);
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [model, setModel] = useState('');

  useEffect(() => {
    if (visible) {
      setEnabled(true);
      setTimes(['07:00']);
      try { setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'); } catch { setTimezone('Asia/Shanghai'); }
      setModel('');
    }
  }, [visible]);

  const valid = !enabled || (times.length > 0 && times.every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)));
  return <SheetFrame visible={visible} onClose={onClose} maxHeight="88%">
    <SheetHeader title={`批量预热 ${count} 个账号`} subtitle="会覆盖所选账号现有的预热配置" onClose={onClose} />
    <ScrollView bounces={false} alwaysBounceVertical={false} overScrollMode="never" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 12 }}>
      <View style={{ minHeight: 48, borderRadius: 12, backgroundColor: colors.card, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 8 }}><Clock3 color={enabled ? colors.primary : colors.subtext} size={16} /><Text style={{ flex: 1, color: colors.text, fontSize: 11, fontWeight: '700' }}>启用定时预热</Text><AppSwitch accessibilityLabel="批量启用定时预热" value={enabled} onValueChange={setEnabled} /></View>
      {enabled ? <><View style={{ gap: 7 }}><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>执行时间</Text>{times.map((time, index) => <View key={index} style={{ flexDirection: 'row', gap: 7 }}><TextInput value={time} onChangeText={(value) => setTimes((current) => current.map((entry, entryIndex) => entryIndex === index ? value : entry))} placeholder="07:00" placeholderTextColor={colors.placeholder} style={{ flex: 1, minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? colors.border : colors.danger, color: colors.text, paddingHorizontal: 11, fontSize: 11 }} /><Pressable accessibilityLabel="移除时间" disabled={times.length <= 1} onPress={() => setTimes((current) => current.filter((_, entryIndex) => entryIndex !== index))} style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center', opacity: times.length <= 1 ? 0.4 : 1 }}><Trash2 color={colors.subtext} size={15} /></Pressable></View>)}<Pressable disabled={times.length >= 8} onPress={() => setTimes((current) => [...current, ''])} style={{ alignSelf: 'flex-start', minHeight: 36, paddingHorizontal: 10, borderRadius: 11, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 5 }}><Plus color={colors.primary} size={14} /><Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }}>添加时间</Text></Pressable></View><AccountInput label="时区" value={timezone} onChangeText={setTimezone} /><AccountInput label="预热模型" value={model} onChangeText={setModel} placeholder="留空自动选择" /></> : null}
      {!valid ? <Text style={{ color: colors.danger, fontSize: 11 }}>请填写有效时间，格式为 HH:mm。</Text> : null}
    </ScrollView>
    <Pressable disabled={!valid || busy} onPress={() => onApply({ warmup: { enabled, times: [...new Set(times)].sort(), timezone: timezone.trim(), model: model.trim() } })} style={{ minHeight: 48, borderRadius: 13, backgroundColor: valid && !busy ? colors.primary : colors.disabled, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }}>{busy ? <ActivityIndicator color="#fff" /> : <Save color="#fff" size={16} />}<Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>应用预热配置</Text></Pressable>
  </SheetFrame>;
}

function FilterSheet({ mode, options, selected, onSelect, onClose }: { mode: FilterMode; options: ChoiceOption[]; selected: string; onSelect: (key: string) => void; onClose: () => void }) {
  const colors = useAppTheme();
  return <SheetFrame visible={Boolean(mode)} onClose={onClose} maxHeight="72%">
    <SheetHeader title={mode === 'status' ? '筛选状态' : mode === 'provider' ? '筛选供应商' : '筛选出口'} onClose={onClose} />
    <FlatList data={options} bounces={false} alwaysBounceVertical={false} overScrollMode="never" keyExtractor={(item) => item.key} style={{ flexGrow: 0 }} renderItem={({ item }) => <Pressable onPress={() => { onSelect(item.key); onClose(); }} style={({ pressed }) => ({ minHeight: 48, borderTopWidth: 1, borderTopColor: colors.rowBorder, flexDirection: 'row', alignItems: 'center', gap: 9, opacity: pressed ? 0.62 : 1 })}><View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text numberOfLines={1} style={{ color: colors.text, fontSize: 11, fontWeight: selected === item.key ? '800' : '600' }}>{item.label}</Text>{item.detail ? <Text numberOfLines={1} style={{ color: colors.subtext, fontSize: 11 }}>{item.detail}</Text> : null}</View>{item.count !== undefined ? <Text style={{ color: colors.subtext, fontSize: 11 }}>{item.count}</Text> : null}{selected === item.key ? <Check color={colors.primary} size={16} /> : null}</Pressable>} />
  </SheetFrame>;
}

export default function AdminAccountsScreen() {
  const colors = useAppTheme();
  const router = useRouter();
  const screenFocused = useScreenFocus();
  const privacy = usePrivacyMode();
  const { width } = useWindowDimensions();
  const wide = width >= 720;
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [providerFilter, setProviderFilter] = useState('all');
  const [egressFilter, setEgressFilter] = useState('all');
  const [listMode, setListMode] = useState<ListMode>('attention');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filterMode, setFilterMode] = useState<FilterMode>('');
  const [selectedId, setSelectedId] = useState('');
  const [diagnosticsAccount, setDiagnosticsAccount] = useState<ApiRecord>();
  const [editingAccount, setEditingAccount] = useState<ApiRecord>();
  const [modelsAccount, setModelsAccount] = useState<ApiRecord>();
  const [warmupAccount, setWarmupAccount] = useState<ApiRecord>();
  const [automationAccount, setAutomationAccount] = useState<ApiRecord>();
  const [bulkSettingsVisible, setBulkSettingsVisible] = useState(false);
  const [bulkWarmupVisible, setBulkWarmupVisible] = useState(false);
  const [bulkBusy, setBulkBusy] = useState('');
  const [importVisible, setImportVisible] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [togglingId, setTogglingId] = useState('');
  const [exportingAll, setExportingAll] = useState(false);

  const accounts = useQuery({
    queryKey: ['admin', 'accounts'],
    queryFn: async ({ signal }) => firstArray<ApiRecord>(await apiJson<unknown>('/admin/accounts', { signal }), ['accounts', 'items', 'data', 'list']),
    refetchInterval: autoRefresh && screenFocused ? 30_000 : false,
  });
  const proxies = useQuery({
    queryKey: ['admin', 'proxies', 'account-options'],
    queryFn: async ({ signal }) => firstArray<ApiRecord>(await apiJson<unknown>('/admin/proxies', { signal }), ['proxies', 'items', 'data', 'list']),
    retry: 0,
  });
  const quota = useQuery({
    queryKey: ['admin', 'quota', 'accounts-page'],
    queryFn: ({ signal }) => apiJson<unknown>('/admin/quota', { signal, cache: 'no-store' }),
    refetchInterval: autoRefresh && screenFocused ? 30_000 : false,
    retry: 0,
  });
  const concurrency = useQuery({
    queryKey: ['admin', 'concurrency', 'accounts-page'],
    queryFn: ({ signal }) => apiJson<unknown>('/admin/concurrency', { signal, cache: 'no-store' }),
    refetchInterval: autoRefresh && screenFocused ? 10_000 : false,
    retry: 0,
  });
  const builtinProviders = useQuery({
    queryKey: ['admin', 'providers', 'builtin', 'account-actions'],
    queryFn: ({ signal }) => apiJson<unknown>('/admin/providers/builtin', { signal }),
    retry: 0,
  });
  const integrationPlugins = useQuery({
    queryKey: ['admin', 'plugins', 'integration', 'account-actions'],
    queryFn: ({ signal }) => apiJson<unknown>('/admin/plugins', { signal, query: { type: 'integration' } }),
    retry: 0,
  });

  useEffect(() => {
    if (!screenFocused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [screenFocused]);

  useEffect(() => {
    setPage(1);
  }, [deferredSearch, egressFilter, listMode, providerFilter, statusFilter]);

  const allAccounts = accounts.data ?? [];
  const proxyItems = proxies.data ?? [];
  const proxiesLoaded = proxies.isSuccess;
  const quotaMap = useMemo(() => quotaAccountMap(quota.data), [quota.data]);
  const concurrencyMap = useMemo(() => concurrencyRowMap(concurrency.data), [concurrency.data]);
  const providerActions = useMemo(() => providerActionMap(builtinProviders.data, integrationPlugins.data), [builtinProviders.data, integrationPlugins.data]);
  const providerAccounts = useMemo(() => providerAccountMap(builtinProviders.data, integrationPlugins.data), [builtinProviders.data, integrationPlugins.data]);
  const selectedAccount = allAccounts.find((item) => accountId(item) === selectedId);
  const providerOptions = useMemo(() => {
    const map = new Map<string, ChoiceOption & { servable: number }>();
    for (const item of allAccounts) {
      const provider = accountProvider(item);
      const current = map.get(provider.key);
      const servable = accountStatus(item, now) === 'active' && !accountEgress(item, proxyItems, proxiesLoaded).missing;
      map.set(provider.key, { key: provider.key, label: provider.label, count: (current?.count ?? 0) + 1, servable: (current?.servable ?? 0) + (servable ? 1 : 0) });
    }
    return [{ key: 'all', label: '全部供应商', count: allAccounts.length }, ...[...map.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')).map((option) => ({ ...option, detail: `${option.servable}/${option.count} 可服务` }))];
  }, [allAccounts, now, proxiesLoaded, proxyItems]);

  const counts = useMemo(() => {
    const statusCounts = Object.fromEntries(statusOrder.map((status) => [status, 0])) as Record<UpstreamAccountStatus, number>;
    let needsAttention = 0;
    let servable = 0;
    for (const item of allAccounts) {
      const status = accountStatus(item, now);
      statusCounts[status] += 1;
      const missingEgress = accountEgress(item, proxyItems, proxiesLoaded).missing;
      if (accountStatusNeedsAttention(status) || missingEgress) needsAttention += 1;
      if (status === 'active' && !missingEgress) servable += 1;
    }
    return { statuses: statusCounts, needsAttention, servable };
  }, [allAccounts, now, proxiesLoaded, proxyItems]);

  const statusOptions = useMemo<ChoiceOption[]>(() => [
    { key: 'all', label: '全部状态', count: allAccounts.length },
    ...statusOrder.map((status) => ({ key: status, label: accountStatusLabels[status], count: counts.statuses[status] })),
  ], [allAccounts.length, counts.statuses]);

  const egressOptions = useMemo<ChoiceOption[]>(() => {
    const direct = allAccounts.filter((item) => accountEgress(item, proxyItems, proxiesLoaded).direct).length;
    const missing = allAccounts.filter((item) => accountEgress(item, proxyItems, proxiesLoaded).missing).length;
    return [
      { key: 'all', label: '全部出口', count: allAccounts.length },
      { key: 'direct', label: '默认网络路径', count: direct },
      { key: 'missing', label: '出口已失效', count: missing },
      ...proxyItems.map((proxy, index) => {
        const id = stringValue(proxy.id) || String(index);
        return { key: id, label: stringValue(proxy.name ?? proxy.host ?? proxy.id) || id, count: allAccounts.filter((item) => accountEgress(item, proxyItems, proxiesLoaded).id === id).length };
      }),
    ];
  }, [allAccounts, proxiesLoaded, proxyItems]);

  const filtered = useMemo(() => {
    const keyword = deferredSearch.trim().toLowerCase();
    const matches = allAccounts.filter((item) => {
      if (statusFilter !== 'all' && accountStatus(item, now) !== statusFilter) return false;
      if (providerFilter !== 'all' && accountProvider(item).key !== providerFilter) return false;
      const egress = accountEgress(item, proxyItems, proxiesLoaded);
      if (egressFilter === 'direct' && !egress.direct) return false;
      if (egressFilter === 'missing' && !egress.missing) return false;
      if (!['all', 'direct', 'missing'].includes(egressFilter) && egress.id !== egressFilter) return false;
      return !keyword || accountSearchText(item, proxyItems, proxiesLoaded).includes(keyword);
    });
    return matches.sort((left, right) => {
      if (listMode === 'provider') {
        const providerOrder = accountProvider(left).label.localeCompare(accountProvider(right).label, 'zh-CN');
        if (providerOrder) return providerOrder;
      } else {
        const attention = accountAttentionRank(left, proxyItems, proxiesLoaded, now) - accountAttentionRank(right, proxyItems, proxiesLoaded, now);
        if (attention) return attention;
      }
      return Number(right.priority ?? 0) - Number(left.priority ?? 0) || accountIdentity(left).primary.localeCompare(accountIdentity(right).primary, 'zh-CN');
    });
  }, [allAccounts, deferredSearch, egressFilter, listMode, now, providerFilter, proxiesLoaded, proxyItems, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / accountPageSize));
  const currentPage = Math.min(page, pageCount);
  const pageAccounts = filtered.slice((currentPage - 1) * accountPageSize, currentPage * accountPageSize);
  const selectedAccounts = allAccounts.filter((item) => selectedIds.has(accountId(item)));
  const pageIds = pageAccounts.map(accountId).filter(Boolean);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  const selectedStatusLabel = statusFilter === 'all' ? '全部状态' : accountStatusLabels[statusFilter];
  const selectedProviderLabel = providerOptions.find((option) => option.key === providerFilter)?.label ?? '全部供应商';
  const selectedEgressLabel = egressOptions.find((option) => option.key === egressFilter)?.label ?? '全部出口';
  const filtersActive = statusFilter !== 'all' || providerFilter !== 'all' || egressFilter !== 'all';

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'quota'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'concurrency'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  }

  function toggleSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function togglePageSelection() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function applyBulkPatch(patch: ApiRecord, label: string) {
    const ids = [...selectedIds];
    if (!ids.length || bulkBusy) return;
    setBulkBusy(label);
    try {
      await apiJson('/admin/accounts/bulk', { method: 'PUT', body: JSON.stringify({ ids, ...patch }), timeoutMs: 120000 });
      setSelectedIds(new Set());
      setBulkSettingsVisible(false);
      setBulkWarmupVisible(false);
      invalidate();
      Alert.alert('批量操作完成', `已为 ${ids.length} 个账号${label}。`);
    } catch (error) {
      Alert.alert('批量操作失败', modelTestError(error));
    } finally {
      setBulkBusy('');
    }
  }

  function confirmBulkPatch(patch: ApiRecord, label: string, destructive = false) {
    const count = selectedIds.size;
    if (!count) return;
    Alert.alert(`批量${label}`, `确定为所选 ${count} 个账号${label}吗？`, [{ text: '取消', style: 'cancel' }, { text: '确认', style: destructive ? 'destructive' : 'default', onPress: () => void applyBulkPatch(patch, label) }]);
  }

  function recoverBulk() {
    const ids = [...selectedIds];
    if (!ids.length || bulkBusy) return;
    Alert.alert('批量恢复账号', `确定恢复所选 ${ids.length} 个账号吗？`, [{ text: '取消', style: 'cancel' }, { text: '恢复', onPress: async () => {
      setBulkBusy('恢复');
      try {
        await apiJson('/admin/accounts/recover', { method: 'POST', body: JSON.stringify({ ids }), timeoutMs: 120000 });
        setSelectedIds(new Set());
        invalidate();
        Alert.alert('批量操作完成', `已恢复 ${ids.length} 个账号。`);
      } catch (error) {
        Alert.alert('批量恢复失败', modelTestError(error));
      } finally {
        setBulkBusy('');
      }
    } }]);
  }

  function deleteBulk() {
    const ids = [...selectedIds];
    if (!ids.length || bulkBusy) return;
    Alert.alert('批量删除账号', `确定删除所选 ${ids.length} 个账号吗？该操作不可撤销。`, [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: async () => {
      setBulkBusy('删除');
      try {
        for (const id of ids) await apiJson(`/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        setSelectedIds(new Set());
        invalidate();
        Alert.alert('批量操作完成', `已删除 ${ids.length} 个账号。`);
      } catch (error) {
        invalidate();
        Alert.alert('批量删除未完全完成', modelTestError(error));
      } finally {
        setBulkBusy('');
      }
    } }]);
  }

  async function toggleAccount(item: ApiRecord) {
    const id = accountId(item);
    if (!id || togglingId || busyAction) return;
    const enable = accountIsDisabled(item);
    setTogglingId(id);
    try {
      await setAdminAccountEnabled(id, enable);
      queryClient.setQueryData<ApiRecord[]>(['admin', 'accounts'], (current) => current?.map((account) => accountId(account) === id
        ? { ...account, status: enable ? 'active' : 'disabled', enabled: enable, disabled: !enable }
        : account));
      invalidate();
    } catch (error) {
      Alert.alert(enable ? '启用失败' : '禁用失败', error instanceof Error ? error.message : '请求失败');
    } finally {
      setTogglingId('');
    }
  }

  async function runAction(key: string, label: string, operation: () => Promise<unknown>) {
    if (busyAction) return;
    setBusyAction(key);
    try {
      await operation();
      setSelectedId('');
      invalidate();
      Alert.alert('已完成', `${label}成功。`);
    } catch (error) {
      Alert.alert(`${label}失败`, error instanceof Error ? error.message : '请求失败');
    } finally {
      setBusyAction('');
    }
  }

  function recoverSelected() {
    if (!selectedAccount) return;
    Alert.alert('恢复账号', `尝试恢复「${accountIdentity(selectedAccount).primary}」？`, [{ text: '取消', style: 'cancel' }, { text: '恢复', onPress: () => void runAction('recover', '恢复账号', () => apiJson(`/admin/accounts/${encodeURIComponent(accountId(selectedAccount))}/recover`, { method: 'POST' })) }]);
  }

  function reauthSelected() {
    if (!selectedAccount) return;
    const proxyId = stringValue(selectedAccount.proxy_id);
    const provider = accountProvider(selectedAccount).key;
    setSelectedId('');
    router.push({ pathname: '/admin-account-import', params: { provider, ...(proxyId ? { proxy_id: proxyId } : {}) } } as never);
  }

  function toggleSelected() {
    if (!selectedAccount) return;
    const enable = accountIsDisabled(selectedAccount);
    Alert.alert(enable ? '启用账号' : '禁用账号', `确定${enable ? '启用' : '禁用'}「${accountIdentity(selectedAccount).primary}」？`, [{ text: '取消', style: 'cancel' }, { text: '确认', style: enable ? 'default' : 'destructive', onPress: () => void runAction('toggle', enable ? '启用账号' : '禁用账号', () => setAdminAccountEnabled(accountId(selectedAccount), enable)) }]);
  }

  function deleteSelected() {
    if (!selectedAccount) return;
    Alert.alert('删除账号', `确定删除「${accountIdentity(selectedAccount).primary}」吗？该操作不可撤销。`, [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => void runAction('delete', '删除账号', () => apiJson(`/admin/accounts/${encodeURIComponent(accountId(selectedAccount))}`, { method: 'DELETE' })) }]);
  }

  function runDynamicAction(action: ApiRecord) {
    if (!selectedAccount) return;
    const actionId = stringValue(action.id ?? action.key);
    const label = localizedText(action.label) || actionId || '供应商操作';
    if (!actionId) return;
    const execute = async () => {
      if (action.type === 'link') {
        const url = stringValue(action.url);
        if (!/^https?:\/\//i.test(url)) {
          Alert.alert('无法打开链接', '供应商返回的链接不是受支持的 HTTP(S) 地址。');
          return;
        }
        await Linking.openURL(url);
        return;
      }
      if (action.type === 'flow') {
        const proxyId = accountEgress(selectedAccount, proxyItems, proxiesLoaded).id;
        setSelectedId('');
        router.push({ pathname: '/admin-account-import', params: { provider: accountProvider(selectedAccount).key, ...(proxyId ? { proxy_id: proxyId } : {}) } } as never);
        return;
      }
      setBusyAction(`dynamic:${actionId}`);
      try {
        const result = await apiJson<ApiRecord>(`/admin/accounts/${encodeURIComponent(accountId(selectedAccount))}/actions/${encodeURIComponent(actionId)}`, { method: 'POST', body: '{}' });
        Alert.alert(`${label}完成`, stringValue(result.message ?? recordValue(result.data).message) || '操作已完成。');
        invalidate();
      } catch (error) {
        Alert.alert(`${label}失败`, modelTestError(error));
      } finally {
        setBusyAction('');
      }
    };
    if (action.confirm === false) void execute();
    else Alert.alert(label, `确定对「${accountIdentity(selectedAccount).primary}」执行${label}吗？`, [{ text: '取消', style: 'cancel' }, { text: '确认', onPress: () => void execute() }]);
  }

  function confirmExport(ids: string[], count: number, all = false) {
    Alert.alert('导出账号', `确定导出 ${count} 个账号吗？导出文件包含敏感凭据，请妥善保存。`, [{ text: '取消', style: 'cancel' }, { text: '导出', onPress: () => void performExport(ids, count, all) }]);
  }

  async function performExport(ids: string[], count: number, all: boolean) {
    if (all) setExportingAll(true);
    else setBusyAction('export');
    setSelectedId('');
    try {
      const result = await apiFetch('/admin/accounts/export', { method: 'POST', body: JSON.stringify({ ids }), responseType: 'blob', timeoutMs: 120000 });
      await shareExportResult(result);
      Alert.alert('导出完成', `已准备 ${count} 个账号的导出文件。`);
    } catch (error) {
      Alert.alert('导出失败', error instanceof Error ? error.message : '请求失败');
    } finally {
      setExportingAll(false);
      setBusyAction('');
    }
  }

  return <>
    <Page title="上游账号" subtitle="账号状态、网络出口与运行维护" icon={CloudCog} safeTop={false} contentMaxWidth={1180} scrollable={false} showHeader={false}>
      <FlatList
        data={pageAccounts}
        extraData={`${now}:${togglingId}:${busyAction}:${privacy.enabled}:${[...selectedIds].join(',')}`}
        bounces={false}
        alwaysBounceVertical={false}
        overScrollMode="never"
        scrollToOverflowEnabled={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        keyExtractor={(item, index) => accountId(item) || String(index)}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ gap: 6, paddingBottom: 10, flexGrow: pageAccounts.length ? 0 : 1 }}
        ListHeaderComponent={<View style={{ gap: 8, paddingBottom: 2 }}>
          <PageHeader title="上游账号" subtitle="账号状态、网络出口与运行维护" icon={CloudCog} refreshing={accounts.isFetching || quota.isFetching || concurrency.isFetching} onRefresh={() => { void accounts.refetch(); void proxies.refetch(); void quota.refetch(); void concurrency.refetch(); }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
            <Pressable accessibilityLabel={privacy.enabled ? '显示完整账号' : '隐藏账号信息'} accessibilityState={{ selected: privacy.enabled }} onPress={() => setPrivacyMode(!privacy.enabled)} style={{ width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: privacy.enabled ? colors.primary : colors.border, backgroundColor: privacy.enabled ? colors.primarySoft : colors.card, alignItems: 'center', justifyContent: 'center' }}>{privacy.enabled ? <EyeOff color={colors.primary} size={17} /> : <Eye color={colors.subtext} size={17} />}</Pressable>
            <CompactButton icon={FileUp} label="导入文件" onPress={() => setImportVisible(true)} />
            <CompactButton icon={Download} label="导出全部" busy={exportingAll} disabled={!allAccounts.length} onPress={() => confirmExport([], allAccounts.length, true)} />
            <CompactButton icon={Plus} label="添加账号" primary onPress={() => router.push('/admin-account-import' as never)} />
          </View>
          <View style={{ minHeight: 40, borderBottomWidth: 1, borderBottomColor: colors.rowBorder, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <SummaryMetric label="全部" value={allAccounts.length} />
            <SummaryMetric label="可服务" value={counts.servable} tone="success" />
            <SummaryMetric label="需处理" value={counts.needsAttention} tone={counts.needsAttention ? 'danger' : undefined} />
            <SummaryMetric label="禁用" value={counts.statuses.disabled} tone={counts.statuses.disabled ? 'danger' : undefined} />
            <View style={{ marginLeft: wide ? 'auto' : 0, minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6 }}><RefreshCw color={autoRefresh ? colors.primary : colors.subtext} size={14} /><Text style={{ color: colors.subtext, fontSize: 11, fontWeight: '600' }}>自动刷新</Text><AppSwitch accessibilityLabel="自动刷新" value={autoRefresh} onValueChange={setAutoRefresh} /></View>
          </View>
          <View style={{ flexDirection: wide ? 'row' : 'column', gap: 7 }}>
            <View style={{ flex: wide ? 1 : undefined, minHeight: 44 }}><SearchField value={search} onChangeText={setSearch} placeholder="搜索账号、邮箱、供应商或出口" /></View>
            <View style={{ minWidth: wide ? 520 : undefined, flexDirection: 'row', gap: 7 }}><FilterButton icon={Filter} label={selectedStatusLabel} active={statusFilter !== 'all'} onPress={() => setFilterMode('status')} /><FilterButton icon={SlidersHorizontal} label={selectedProviderLabel} active={providerFilter !== 'all'} onPress={() => setFilterMode('provider')} /><FilterButton icon={Network} label={selectedEgressLabel} active={egressFilter !== 'all'} onPress={() => setFilterMode('egress')} />{filtersActive ? <Pressable accessibilityLabel="清除筛选" onPress={() => { setStatusFilter('all'); setProviderFilter('all'); setEgressFilter('all'); }} style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}><X color={colors.subtext} size={15} /></Pressable> : null}</View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Pressable accessibilityLabel={allPageSelected ? '取消选择本页' : '选择本页'} onPress={togglePageSelection} style={{ width: 40, height: 38, borderRadius: 11, backgroundColor: allPageSelected ? colors.primarySoft : colors.mutedCard, alignItems: 'center', justifyContent: 'center' }}>{allPageSelected ? <CheckSquare2 color={colors.primary} size={17} /> : <Square color={colors.subtext} size={17} />}</Pressable><View style={{ flex: 1, flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: colors.mutedCard }}>{([['attention', '优先排障', Wrench], ['provider', '按供应商分组', Layers3]] as const).map(([value, label, Icon]) => <Pressable key={value} onPress={() => setListMode(value)} style={{ flex: 1, minHeight: 32, borderRadius: 8, backgroundColor: listMode === value ? colors.card : 'transparent', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }}><Icon color={listMode === value ? colors.primary : colors.subtext} size={14} /><Text numberOfLines={1} style={{ color: listMode === value ? colors.primary : colors.subtext, fontSize: 11, fontWeight: '700' }}>{label}</Text></Pressable>)}</View></View>
          {selectedIds.size ? <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.rowBorder, paddingVertical: 8, gap: 7 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text style={{ flex: 1, color: colors.text, fontSize: 11, fontWeight: '800' }}>已选择 {selectedIds.size} 个</Text><Pressable onPress={() => setSelectedIds(new Set())}><Text style={{ color: colors.primary, fontSize: 11, fontWeight: '700' }}>清除</Text></Pressable></View><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}><CompactButton icon={Play} label="启用" disabled={Boolean(bulkBusy)} onPress={() => confirmBulkPatch({ status: 'active' }, '启用')} /><CompactButton icon={Power} label="禁用" disabled={Boolean(bulkBusy)} onPress={() => confirmBulkPatch({ status: 'disabled' }, '禁用', true)} /><CompactButton icon={RotateCcw} label="恢复" disabled={Boolean(bulkBusy)} onPress={recoverBulk} /><CompactButton icon={SlidersHorizontal} label="批量配置" disabled={Boolean(bulkBusy)} onPress={() => setBulkSettingsVisible(true)} /><CompactButton icon={Clock3} label="批量预热" disabled={Boolean(bulkBusy)} onPress={() => setBulkWarmupVisible(true)} /><CompactButton icon={Download} label="导出" disabled={Boolean(bulkBusy)} onPress={() => confirmExport([...selectedIds], selectedIds.size)} /><CompactButton icon={Trash2} label="删除" disabled={Boolean(bulkBusy)} onPress={deleteBulk} /></View></View> : null}
          {proxies.error ? <Text style={{ color: colors.warning, fontSize: 11 }}>出口配置暂时无法核对：{proxies.error.message}</Text> : null}
          {accounts.error ? <ErrorState message={accounts.error.message} retry={() => accounts.refetch()} /> : null}
          {accounts.data ? <Text style={{ color: colors.subtext, fontSize: 11 }}>显示 {filtered.length} / {allAccounts.length} · 第 {currentPage} / {pageCount} 页</Text> : null}
        </View>}
        ListEmptyComponent={accounts.isLoading ? <View style={{ flex: 1, minHeight: 180, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View> : <EmptyState icon={filtersActive || search.trim() ? SearchX : CloudCog} message={filtersActive || search.trim() ? '没有匹配的账号' : '暂无上游账号'} />}
        ListFooterComponent={filtered.length ? <View style={{ minHeight: 48, paddingTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}><Pressable accessibilityLabel="上一页" disabled={currentPage <= 1} onPress={() => setPage((value) => Math.max(1, value - 1))} style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center', opacity: currentPage <= 1 ? 0.4 : 1 }}><ChevronLeft color={colors.text} size={17} /></Pressable><Text style={{ color: colors.subtext, fontSize: 11 }}>第 {currentPage} / {pageCount} 页</Text><Pressable accessibilityLabel="下一页" disabled={currentPage >= pageCount} onPress={() => setPage((value) => Math.min(pageCount, value + 1))} style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: colors.mutedCard, alignItems: 'center', justifyContent: 'center', opacity: currentPage >= pageCount ? 0.4 : 1 }}><ChevronRight color={colors.text} size={17} /></Pressable></View> : null}
        renderItem={({ item, index }) => <View style={{ gap: 6 }}>{listMode === 'provider' && (index === 0 || accountProvider(pageAccounts[index - 1]).key !== accountProvider(item).key) ? <View style={{ minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: index ? 6 : 0 }}><ProviderIcon provider={item} size={26} /><Text style={{ flex: 1, color: colors.text, fontSize: 12, fontWeight: '800' }}>{accountProvider(item).label}</Text><Text style={{ color: colors.subtext, fontSize: 11 }}>{filtered.filter((candidate) => accountProvider(candidate).key === accountProvider(item).key).length} 个</Text></View> : null}<AccountCard item={item} quota={quotaMap.get(accountId(item))} concurrency={concurrencyMap.get(accountId(item))} proxies={proxyItems} proxiesLoaded={proxiesLoaded} privacy={privacy.enabled} selected={selectedIds.has(accountId(item))} now={now} toggling={togglingId === accountId(item)} toggleLocked={Boolean(togglingId || busyAction || bulkBusy)} onPress={() => setDiagnosticsAccount(item)} onSelect={() => toggleSelection(accountId(item))} onToggle={() => void toggleAccount(item)} /></View>}
      />
    </Page>

    <AccountActionsSheet
      account={selectedAccount}
      dynamicActions={selectedAccount ? providerActions.get(accountProvider(selectedAccount).key) ?? [] : []}
      busyAction={busyAction}
      onClose={() => setSelectedId('')}
      onDiagnose={() => { if (selectedAccount) setDiagnosticsAccount(selectedAccount); setSelectedId(''); }}
      onRecover={recoverSelected}
      onReauth={reauthSelected}
      onEdit={() => { if (selectedAccount) setEditingAccount(selectedAccount); setSelectedId(''); }}
      onModels={() => { if (selectedAccount) setModelsAccount(selectedAccount); setSelectedId(''); }}
      onWarmup={() => { if (selectedAccount) setWarmupAccount(selectedAccount); setSelectedId(''); }}
      onAutomation={() => { if (selectedAccount) setAutomationAccount(selectedAccount); setSelectedId(''); }}
      onDynamicAction={runDynamicAction}
      onToggle={toggleSelected}
      onExport={() => { if (selectedAccount) confirmExport([accountId(selectedAccount)], 1); }}
      onDelete={deleteSelected}
    />
    <AccountDiagnosticsSheet account={diagnosticsAccount} quota={diagnosticsAccount ? quotaMap.get(accountId(diagnosticsAccount)) : undefined} concurrency={diagnosticsAccount ? concurrencyMap.get(accountId(diagnosticsAccount)) : undefined} proxies={proxyItems} proxiesLoaded={proxiesLoaded} privacy={privacy.enabled} onClose={() => setDiagnosticsAccount(undefined)} onEdit={() => { if (diagnosticsAccount) setEditingAccount(diagnosticsAccount); setDiagnosticsAccount(undefined); }} onModels={() => { if (diagnosticsAccount) setModelsAccount(diagnosticsAccount); setDiagnosticsAccount(undefined); }} onActions={() => { if (diagnosticsAccount) setSelectedId(accountId(diagnosticsAccount)); setDiagnosticsAccount(undefined); }} />
    <AccountEditSheet account={editingAccount} providerAccount={editingAccount ? providerAccounts.get(accountProvider(editingAccount).key) : undefined} accounts={allAccounts} proxies={proxyItems} proxiesLoaded={proxiesLoaded} onClose={() => setEditingAccount(undefined)} onSaved={invalidate} onActions={() => { if (!editingAccount) return; setSelectedId(accountId(editingAccount)); setEditingAccount(undefined); }} />
    <AccountModelsSheet account={modelsAccount} onClose={() => setModelsAccount(undefined)} />
    <WarmupSheet account={warmupAccount} onClose={() => setWarmupAccount(undefined)} onSaved={invalidate} />
    <AutomationSheet account={automationAccount} onClose={() => setAutomationAccount(undefined)} />
    <ImportSheet visible={importVisible} onClose={() => setImportVisible(false)} onImported={invalidate} />
    <BulkSettingsSheet visible={bulkSettingsVisible} count={selectedIds.size} proxies={proxyItems} busy={Boolean(bulkBusy)} onClose={() => setBulkSettingsVisible(false)} onApply={(patch) => void applyBulkPatch(patch, '更新配置')} />
    <BulkWarmupSheet visible={bulkWarmupVisible} count={selectedIds.size} busy={Boolean(bulkBusy)} onClose={() => setBulkWarmupVisible(false)} onApply={(patch) => void applyBulkPatch(patch, '更新预热配置')} />
    <FilterSheet mode={filterMode} options={filterMode === 'status' ? statusOptions : filterMode === 'provider' ? providerOptions : egressOptions} selected={filterMode === 'status' ? statusFilter : filterMode === 'provider' ? providerFilter : egressFilter} onSelect={(value) => filterMode === 'status' ? setStatusFilter(value as StatusFilter) : filterMode === 'provider' ? setProviderFilter(value) : setEgressFilter(value)} onClose={() => setFilterMode('')} />
  </>;
}
