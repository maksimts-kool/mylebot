import { describe, expect, it, vi } from "vitest";
import { permissionsSection } from "../../src/features/config/sections/permissions.js";
import { PermissionLevel } from "../../src/shared/permissions.js";

function guildClient(roleNames: Record<string, string>) {
  return {
    guilds: {
      cache: {
        get: () => ({
          roles: { cache: { get: (id: string) => (roleNames[id] ? { name: roleNames[id] } : undefined) } },
        }),
      },
    },
  };
}

function roleSelect(roleId: string) {
  return {
    values: [roleId],
    isRoleSelectMenu: () => true,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
  };
}

function stringSelect(value: string) {
  return {
    values: [value],
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => true,
    isChannelSelectMenu: () => false,
  };
}

const button = {
  isRoleSelectMenu: () => false,
  isStringSelectMenu: () => false,
  isChannelSelectMenu: () => false,
};

describe("role permission management", () => {
  it("lists every configured role grouped by the level it grants", async () => {
    const db = {
      permissionRole: {
        findMany: vi.fn().mockResolvedValue([
          { roleId: "10", level: PermissionLevel.MANAGER },
          { roleId: "20", level: PermissionLevel.STAFF },
        ]),
      },
    };
    const section = permissionsSection(db as never, guildClient({ 10: "Leads", 20: "Moderators" }) as never, "guild-1");

    const view = await section.view();
    const embed = view.embeds[0]!.toJSON();
    expect(embed.fields?.find((field) => field.name.startsWith("Manager"))?.value).toBe("<@&10>");
    expect(embed.fields?.find((field) => field.name.startsWith("Admin"))?.value).toBe("_No roles_");
    // A role select to add or change, and a menu to revoke an existing one.
    expect(view.components).toHaveLength(2);
  });

  it("offers only the revoke menu once at least one role is configured", async () => {
    const db = { permissionRole: { findMany: vi.fn().mockResolvedValue([]) } };
    const section = permissionsSection(db as never, guildClient({}) as never, "guild-1");
    expect((await section.view()).components).toHaveLength(1);
  });

  it("asks which level a newly chosen role should get", async () => {
    const db = { permissionRole: { findUnique: vi.fn().mockResolvedValue(null) } };
    const section = permissionsSection(db as never, guildClient({ 30: "Helpers" }) as never, "guild-1");

    const view = await section.apply(roleSelect("30") as never, "role");
    expect(view?.embeds[0]!.toJSON().description).toContain("<@&30>");
    const labels = view?.components[0]!.toJSON().components.map((component) => ("label" in component ? component.label : ""));
    expect(labels).toEqual(["Staff", "Admin", "Manager", "Remove", "Back"]);
  });

  it("grants, changes, and revokes a role's access", async () => {
    const upsert = vi.fn();
    const deleteMany = vi.fn();
    const db = { permissionRole: { findMany: vi.fn().mockResolvedValue([]), upsert, deleteMany } };
    const section = permissionsSection(db as never, guildClient({}) as never, "guild-1");

    await section.apply(button as never, `level:40:${PermissionLevel.ADMIN}`);
    expect(upsert).toHaveBeenCalledWith({
      where: { roleId: "40" },
      create: { roleId: "40", level: PermissionLevel.ADMIN },
      update: { level: PermissionLevel.ADMIN },
    });

    await section.apply(button as never, "level:40:remove");
    expect(deleteMany).toHaveBeenLastCalledWith({ where: { roleId: "40" } });

    await section.apply(stringSelect("50") as never, "revoke");
    expect(deleteMany).toHaveBeenLastCalledWith({ where: { roleId: "50" } });
  });

  it("refuses a level that is not one of the three assignable ones", async () => {
    const db = { permissionRole: { upsert: vi.fn() } };
    const section = permissionsSection(db as never, guildClient({}) as never, "guild-1");
    await expect(section.apply(button as never, "level:60:1")).rejects.toThrow(/Invalid permission level/);
    expect(db.permissionRole.upsert).not.toHaveBeenCalled();
  });
});
