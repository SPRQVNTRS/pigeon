import { redirect } from 'react-router';
import type { Route } from './+types/admin._index';

export async function loader(_: Route.LoaderArgs) {
  return redirect('/admin/dashboard');
}
