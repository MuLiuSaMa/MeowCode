/**
 * 模型列表「落盘回执」与「本次提交」的对账。
 *
 * 背景（就是那个「删掉模型过一会又出现」的 bug）：
 * `meow:save-settings` 写完盘还要 `await startServer()` 重启 agent 服务，
 * 一次保存的回执要好几秒才回来。这段时间里用户完全可能再删一个模型，
 * 于是两次保存并发。旧那次的回执带着**旧列表**回来时，如果无条件
 * `setSettings(回执)`，刚删掉的模型就被写回界面（磁盘其实是对的，重启后又没了），
 * 表现为「过一会又出现」。
 *
 * 两条纪律：
 *  1. 只有最新一次提交的回执才能写回界面（代际号，调用方维护）；
 *  2. 回执里的模型集合必须收敛到本次提交的集合 —— 即便主进程因为读到旧文件/备份
 *     回来一份旧列表，也不允许已删除的条目复活。
 */

export type ProviderEcho<T extends { id: string }> = {
  providers?: T[];
  providerId?: string;
};

export type ReconciledProviders<T extends { id: string }> = {
  providers: T[] | undefined;
  providerId: string | undefined;
};

/**
 * 用「本次提交」校准「落盘回执」。
 *
 * - providers：按提交的 id 集合过滤回执。回执没有该字段时退回提交内容。
 * - providerId：回执的激活项若指向已不在集合里的模型（本次删掉的），
 *   回落到提交时算出的激活项。
 */
export function reconcileProviderEcho<T extends { id: string }>(input: {
  saved: ProviderEcho<T>;
  submitted: ProviderEcho<T>;
}): ReconciledProviders<T> {
  const submittedProviders = input.submitted.providers;
  const submittedIds = new Set((submittedProviders ?? []).map((item) => item.id));
  const savedProviders = input.saved.providers;
  const providers = savedProviders
    ? savedProviders.filter((item) => submittedIds.has(item.id))
    : submittedProviders;
  const savedActive = input.saved.providerId;
  const providerId =
    savedActive && submittedIds.has(savedActive) ? savedActive : input.submitted.providerId;
  return { providers, providerId };
}
