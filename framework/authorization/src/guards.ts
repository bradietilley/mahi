/**
 * Composable wrappers for the two overwhelmingly common ways a policy
 * method handles guests, so they don't have to be hand-written (and
 * occasionally forgotten) in every method.
 *
 * Used as class property initializers, which is how a wrapper composes
 * with the class-based `Policy` shape:
 *
 *   export class PostPolicy extends Policy<UserRow, PostTable> {
 *     // Guest-aware, written out by hand:
 *     view(user: UserRow | null, post: PostTable): boolean {
 *       if (post.published) return true;
 *       return user !== null && post.user_id === user.id;
 *     }
 *
 *     // Owner-only. `user` is non-null inside the callback:
 *     update = requireAuth<UserRow, [PostTable]>((user, post) => post.user_id === user.id);
 *
 *     // Guests only (e.g. "may this visitor see the signup form"):
 *     register = requireGuest<[]>(() => true);
 *   }
 *
 * Both styles behave identically at the call site. These are a
 * convenience, not required ceremony.
 */

/**
 * Deny guests outright; hand the callback a guaranteed non-null user.
 *
 * The type narrowing is the point: without it every owner-check body
 * needs its own `user === null` branch, and the one that gets forgotten
 * is a null-dereference at best or an authorization bypass at worst.
 */
export function requireAuth<TUser, TArgs extends unknown[] = unknown[]>(
  callback: (user: TUser, ...args: TArgs) => boolean | Promise<boolean>,
): (user: TUser | null, ...args: TArgs) => boolean | Promise<boolean> {
  return (user, ...args) => (user === null ? false : callback(user, ...args));
}

/**
 * Deny authenticated users; the callback never receives a user at all.
 *
 * The mirror image of `requireAuth`, for abilities that only make sense
 * for anonymous visitors.
 */
export function requireGuest<TArgs extends unknown[] = unknown[]>(
  callback: (...args: TArgs) => boolean | Promise<boolean>,
): (user: unknown | null, ...args: TArgs) => boolean | Promise<boolean> {
  return (user, ...args) => (user === null ? callback(...args) : false);
}
