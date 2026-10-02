import type { ProviderConfigLayerUpdate } from "@acode/provider";
import { ApiKeyAccessConfig, ProviderConfig, type ProviderApiKeyVault } from "@acode/provider";

/**
 * 写盘前把明文 BYO API Key 搬进加密凭据库，文件里只留 `credentialRef`（安全加固 P1-5）。
 *
 * **为什么挂在 repository 的写入漏斗上**：`#writeLocked` 是个人 Provider 配置唯一的落盘出口，
 * 在这里拦截一次即可覆盖所有写入路径（`savePersonalProviderOverlay`、迁移、导入…），
 * 不必逐个改调用方，也不会漏掉将来新增的写入路径。
 *
 * **顺序即安全**：`vault.save` 成功返回引用之后，才允许把明文换成引用。若 save 抛错，
 * 异常向上传播、本次写入整体放弃——文件里继续存原来的明文，用户的 Key 不会被弄丢，
 * 下次写入再重试。绝不出现「明文已从文件移除、凭据库却没有」的中间态。
 *
 * **revision 一致性**：本函数产出的 update 只含引用（稳定字符串），因此
 * `revision = sha256(encode(update))` 与磁盘内容一致；不会像随机 IV 的内联密文那样，
 * 每次编码都变、导致轮询误判「配置变化」而反复重写文件。
 */
/**
 * 廉价判定：update 里是否还有明文 BYO apiKey（即「尚未迁移」）。
 *
 * 存在的理由是避免读路径的快通道也去调 `vault.save`：快通道只做「磁盘内容是否已等于规范形态」
 * 的比较，若为判断迁移状态而调一次 vault，随后加锁重写又会调一次，同一把 Key 会被存两遍
 * （引用是确定性命名，不会出错，但纯属浪费且语义含糊）。改为先用本谓词判定，
 * 有明文才走加锁迁移路径，快通道在已迁移状态下**完全不触碰凭据库**。
 */
export function hasPlaintextApiKeys(update: ProviderConfigLayerUpdate): boolean {
  for (const rule of update.providers.rules()) {
    const access = rule.config.access;
    if (!(access instanceof ApiKeyAccessConfig)) {
      continue;
    }
    if (typeof access.apiKey === "string" && access.apiKey.trim().length > 0) {
      return true;
    }
  }
  return false;
}

export async function vaultPersonalProviderApiKeys(
  update: ProviderConfigLayerUpdate,
  vault: ProviderApiKeyVault | undefined,
): Promise<{ update: ProviderConfigLayerUpdate; vaulted: number }> {
  if (!vault) {
    return { update, vaulted: 0 };
  }

  // mapConfigs 是同步的，而 vault.save 是异步的：先串行收集需要搬运的条目，再一次性重建 map。
  // 数量级是个位数（用户自建的 BYO provider），串行不构成性能问题，且能保证「先入库再改文件」的顺序。
  const replacements = new Map<string, ProviderConfig>();
  for (const rule of update.providers.rules()) {
    const access = rule.config.access;
    if (!(access instanceof ApiKeyAccessConfig)) {
      continue;
    }
    const apiKey = access.apiKey;
    // 没有明文 Key（已是 ref 形态，或本来就没配 Key）→ 无需搬运。
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      continue;
    }
    // 关键顺序：先写凭据库，成功后才生成只含 ref 的替换配置。
    const credentialRef = await vault.save(rule.providerId, apiKey);
    replacements.set(
      rule.providerId,
      new ProviderConfig({
        ...rule.config,
        access: new ApiKeyAccessConfig({
          type: access.type,
          // 不写 apiKey：toJSON() 在有 ref 时也会丢弃它，这里直接不给，避免运行期误用明文。
          apiKeyManagementUrl: access.apiKeyManagementUrl,
          credentialRef,
        }),
      }),
    );
  }

  if (replacements.size === 0) {
    return { update, vaulted: 0 };
  }

  return {
    update: {
      ...update,
      providers: update.providers.mapConfigs(
        (config, providerId) => replacements.get(providerId) ?? config,
      ),
    },
    vaulted: replacements.size,
  };
}

/** 收集 update 里所有 BYO access 当前引用的 credentialRef（按 ref 字符串去重）。 */
function collectApiKeyCredentialRefs(update: ProviderConfigLayerUpdate): Set<string> {
  const refs = new Set<string>();
  for (const rule of update.providers.rules()) {
    const access = rule.config.access;
    if (!(access instanceof ApiKeyAccessConfig)) continue;
    const ref = access.credentialRef;
    if (typeof ref === "string" && ref.trim().length > 0) {
      refs.add(ref);
    }
  }
  return refs;
}

/**
 * 孤儿凭据清理（安全加固 P1-5 回归修复：删除 provider 后凭据条目不能永久残留）。
 *
 * 对比提交前后两份 update 引用的 credentialRef 集合，删除**消失**的 ref。按 ref 字符串而非
 * providerId 判断：provider 删除、access 类型切换、ref 被移除三种孤儿来源一并覆盖，且绝不误删
 * 仍被任何 provider 引用的条目（包括 ref 被挪到别的 provider 上的极端情况）。
 *
 * **调用时机必须是文件已提交之后**（见 repository.update）：反序会在写文件失败时留下
 * 「引用悬空且真值已删」的真丢 Key 状态；正序的最坏情况只是留下孤儿条目（非破坏）。
 *
 * 返回删除的条目数。单条 delete 抛错时中止后续清理并向上抛出——调用方决定如何上报；
 * 文件状态不受影响。
 */
export async function deleteOrphanedProviderApiKeys(
  before: ProviderConfigLayerUpdate,
  after: ProviderConfigLayerUpdate,
  vault: ProviderApiKeyVault | undefined,
): Promise<number> {
  // 未注入 vault（纯 builtin / 测试 / 凭据库不可用）→ 无凭据可清理，安全空操作。
  if (!vault) return 0;
  const beforeRefs = collectApiKeyCredentialRefs(before);
  if (beforeRefs.size === 0) return 0;
  const afterRefs = collectApiKeyCredentialRefs(after);
  let deleted = 0;
  for (const ref of beforeRefs) {
    if (afterRefs.has(ref)) continue;
    await vault.delete(ref);
    deleted += 1;
  }
  return deleted;
}
