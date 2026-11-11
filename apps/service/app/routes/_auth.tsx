import type { Route } from './+types/_auth';
import { Outlet } from 'react-router';
import { authMiddleware } from '#app/middleware/auth';
import { getUser } from '#app/middleware/helpers';

export const middleware = [authMiddleware];

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  return { user };
}

export default function AuthLayout() {
  return <Outlet />;
}
