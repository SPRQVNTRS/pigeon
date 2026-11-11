import { redirect } from 'react-router';
import type { Route } from './+types/dashboard';

export async function loader(_: Route.LoaderArgs) {
  return redirect('/admin/dashboard');
}
