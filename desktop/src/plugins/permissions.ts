import type { PluginDescriptor, PluginPermission } from "../api";

/** 插件未声明权限时的拒绝：调用方应按可展示错误处理。 */
export class PluginPermissionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly permission: PluginPermission,
  ) {
    super(`plugin "${pluginId}" did not declare the "${permission}" permission`);
    this.name = "PluginPermissionError";
  }
}

export function pluginPermissions(descriptor: PluginDescriptor): PluginPermission[] {
  return descriptor.manifest?.permissions ?? [];
}

/** 没有 manifest 的旧插件没有 client，因此这里只用于 client 侧检查。 */
export function hasPermission(
  descriptor: PluginDescriptor,
  permission: PluginPermission,
): boolean {
  return pluginPermissions(descriptor).includes(permission);
}

export function requirePermission(
  descriptor: PluginDescriptor,
  permission: PluginPermission,
): void {
  if (!hasPermission(descriptor, permission)) {
    throw new PluginPermissionError(descriptor.id, permission);
  }
}
