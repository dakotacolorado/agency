import { fixedRoles, roleSkill, type Role } from "./roles.ts";

const role = (name: string, fields: Partial<Role> & Pick<Role, "label" | "priority" | "whenDone">): Role => ({
  name,
  skills: [roleSkill(name)],
  credentials: null,
  description: `The ${name} role.`,
  brief: null,
  capability: 3,
  version: 1,
  ...fields,
});

/** Roles as honed's `agent-roles/` might hold them, for the tests. */
export const TEST_ROLES: readonly Role[] = [
  role("planner", { label: "plan: new work", priority: 40, whenDone: "stop", brief: "You are a planner. Ask the person what they want done." }),
  role("reviewer", { label: "review", priority: 30, whenDone: "delete" }),
  role("onboarder", { label: "onboard", priority: 30, whenDone: "delete" }),
  role("implementer", { label: "ticket", priority: 10, whenDone: "stop", capability: 2 }),
];

export const testRoles = () => fixedRoles([...TEST_ROLES]);
