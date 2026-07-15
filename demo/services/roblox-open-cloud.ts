import { z } from "zod";

// Roblox Open Cloud v2 Groups client. Sets a member's group role so the game,
// Adonis, and the session tracker all pick up the new rank — no in-game system.
// Responses are validated at the boundary (zod), like src/services/bloxlink.ts.

export interface RankSyncResult {
  ok: boolean;
  dryRun: boolean;
  message: string;
}

export interface GroupRole {
  id: string;
  name: string;
  rank: number;
}

const roleSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  displayName: z.string().default(""),
  name: z.string().optional(),
  rank: z.coerce.number().int().default(0),
});

const rolesResponseSchema = z.object({
  groupRoles: z.array(roleSchema).default([]),
});

const membershipSchema = z.object({
  // e.g. "groups/123/memberships/ABC123"
  path: z.string(),
  user: z.string().optional(),
  role: z.string().optional(),
});

const membershipsResponseSchema = z.object({
  groupMemberships: z.array(membershipSchema).default([]),
});

export interface OpenCloudConfig {
  apiKey: string | null;
  groupId: string;
  baseUrl: string;
}

export class RobloxOpenCloudService {
  constructor(private readonly config: OpenCloudConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.apiKey) && this.config.groupId !== "0";
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        "x-api-key": this.config.apiKey ?? "",
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(8_000),
    });
  }

  async listRoles(): Promise<GroupRole[]> {
    if (!this.enabled) return [];
    const response = await this.request(`/groups/${this.config.groupId}/roles`);
    if (!response.ok) throw new Error(`Open Cloud roles request failed (${response.status})`);
    const body = rolesResponseSchema.parse(await response.json());
    return body.groupRoles.map((role) => ({ id: role.id, name: role.name ?? role.displayName, rank: role.rank }));
  }

  /** Resolve the membership resource id for a Roblox user in the group. */
  private async membershipId(robloxUserId: string): Promise<string | null> {
    const filter = encodeURIComponent(`user == 'users/${robloxUserId}'`);
    const response = await this.request(`/groups/${this.config.groupId}/memberships?maxPageSize=1&filter=${filter}`);
    if (!response.ok) throw new Error(`Open Cloud membership lookup failed (${response.status})`);
    const body = membershipsResponseSchema.parse(await response.json());
    const path = body.groupMemberships[0]?.path;
    if (!path) return null;
    const id = path.split("/").pop();
    return id ?? null;
  }

  /**
   * Set a member's group role. When the API key is unset this is a dry-run that only
   * reports the intended change, so the full Discord flow is demoable offline.
   */
  async setRank(robloxUserId: string, groupRoleId: string): Promise<RankSyncResult> {
    if (!this.enabled) {
      return { ok: true, dryRun: true, message: `Dry-run: would set Roblox user ${robloxUserId} to group role ${groupRoleId}.` };
    }
    if (!groupRoleId) {
      return { ok: false, dryRun: false, message: "No Roblox group role id is mapped for that rank. Set it in /staff config." };
    }
    try {
      const membershipId = await this.membershipId(robloxUserId);
      if (!membershipId) {
        return { ok: false, dryRun: false, message: `Roblox user ${robloxUserId} is not a member of the group, so their rank cannot be set.` };
      }
      const response = await this.request(`/groups/${this.config.groupId}/memberships/${membershipId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: `groups/${this.config.groupId}/roles/${groupRoleId}` }),
      });
      if (response.ok) {
        return { ok: true, dryRun: false, message: `Set Roblox user ${robloxUserId} to group role ${groupRoleId}.` };
      }
      if (response.status === 403) {
        return { ok: false, dryRun: false, message: "Open Cloud refused the rank change (403). The bot account must outrank the target and the key needs group role-management scope." };
      }
      return { ok: false, dryRun: false, message: `Open Cloud rank change failed (${response.status}).` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return { ok: false, dryRun: false, message: `Open Cloud rank change errored: ${reason}` };
    }
  }
}
