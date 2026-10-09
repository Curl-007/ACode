/** Node 装配公开入口；浏览器服务读面使用 contract.ts，不导入这些 IO adapters。 */
export { createStorageService } from "./app/storageService.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./app/ports.js";
export { createFsStorageCleaner } from "./adapters/fsCleaner.js";
export { createStorageRootsResolver, resolveStorageRoots } from "./adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./adapters/volumeProbe.js";
export { runStorageScan } from "./adapters/inProcessScanRunner.js";
