import type { Db } from "../core/db.js";
import { highestLevel } from "./permissions.js";

export type PermissionRoleRow = { roleId: string; level: number };

/**
 * Which Discord roles grant which access level. The server half owns the rows;
 * the bot half asks through the shared port, with the role ids it read off the
 * interaction.
 */
export class PermissionRoleService {
  constructor(private readonly db: Db) {}

  /** The highest level any of these roles grants, never below Everyone. */
  async levelFor(roleIds: string[]): Promise<number> {
    if (!roleIds.length) return highestLevel([]);
    const configured = await this.db.permissionRole.findMany({ where: { roleId: { in: roleIds } }, select: { level: true } });
    return highestLevel(configured.map(({ level }) => level));
  }

  /** Every configured role, highest level first, then oldest first. */
  async list(): Promise<PermissionRoleRow[]> {
    return this.db.permissionRole.findMany({
      orderBy: [{ level: "desc" }, { createdAt: "asc" }],
      select: { roleId: true, level: true },
    });
  }

  async get(roleId: string): Promise<PermissionRoleRow | null> {
    return this.db.permissionRole.findUnique({ where: { roleId }, select: { roleId: true, level: true } });
  }

  async set(roleId: string, level: number): Promise<void> {
    await this.db.permissionRole.upsert({ where: { roleId }, create: { roleId, level }, update: { level } });
  }

  async remove(roleId: string): Promise<void> {
    await this.db.permissionRole.deleteMany({ where: { roleId } });
  }
}
