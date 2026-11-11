/**
 * User Formatters
 */

import type { SelectUser } from '#drizzle/schema';
import type { TableColumn } from '../types';
import { c, colorStatus, printField, printSection, formatDate } from '../output';

export const userColumns: TableColumn<SelectUser>[] = [
  { header: 'ID', key: 'id', width: 8 },
  { header: 'Name', key: 'name', width: 25 },
  { header: 'Email', key: 'email', width: 35 },
  { header: 'Role', key: 'role', width: 12 },
  {
    header: 'Status',
    key: (user) => (user.deactivated ? colorStatus('deactivated') : colorStatus('active')),
    width: 14,
  },
];

export function printUserDetail(user: SelectUser): void {
  printSection('User Details');
  printField('ID', String(user.id));
  printField('Name', user.name);
  printField('Email', user.email);
  printField('Role', user.role);
  printField('Status', user.deactivated ? 'Deactivated' : 'Active');
  printField('Created At', formatDate(user.createdAt));
  printField('Updated At', formatDate(user.updatedAt));
}
