import type { IStorageService, StorageUsageSnapshot } from "./contract.js";

/** 接口消费示例：只读取 owner 快照，按自己的 jobId 消费进度并释放订阅。 */
export async function observeStorageScan(
  service: IStorageService,
  update: (snapshot: StorageUsageSnapshot) => void,
): Promise<() => Promise<void>> {
  const { jobId } = await service.startScan();
  const subscription = service.onScanProgress((snapshot) => {
    if (snapshot.jobId === jobId) update(snapshot);
  });
  const latest = await service.getSnapshot();
  if (latest?.jobId === jobId) update(latest);
  return async () => {
    subscription.dispose();
    await service.cancelScan(jobId);
  };
}
