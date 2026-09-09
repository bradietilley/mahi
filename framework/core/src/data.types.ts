/**
 * Compile-time checks for the path-typed data helpers. Included via
 * `tsconfig` `src/` — not imported at runtime.
 */
import { dataForget, dataGet, dataHas, dataSet } from "./data.js";

const data = {
  user: {
    address: { country: "AU" },
    roles: ["admin", "user"],
  },
};

const country: string = dataGet(data, "user.address.country");
const role: string = dataGet(data, "user.roles.0");
const roles: string[] = dataGet(data, "user.roles.*");
const withFallback: string | number = dataGet(data, "user.address.country", 123);
const fromSegments: string = dataGet(data, ["user", "address", "country"]);

dataSet(data, "user.address.country", "NZ");
dataSet(data, "user.roles.0", "admin");
dataSet(data, "user.address", { country: "AU" });
dataHas(data, "user.address.country");
dataForget(data, "user.roles.0");

void country;
void role;
void roles;
void withFallback;
void fromSegments;

// @ts-expect-error primitives are not traversable
dataGet("Test", "abc.def");

// @ts-expect-error no such path
dataGet(data, "user.address.foo");

// @ts-expect-error array requires a numeric index
dataGet(data, "user.roles.foo");

// @ts-expect-error wrong value type
dataSet(data, "user.address.country", 42);

// @ts-expect-error wrong array element type
dataSet(data, "user.roles.0", 123);
