import * as React from 'react';
import {
  LayoutDashboard,
  type LucideIcon,
} from 'lucide-react';
import { useUser } from '#app/hooks/use-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroupLabel,
  useSidebar,
} from '#app/components/ui/sidebar';
import { Link, useLocation } from 'react-router';
import { Bird } from 'lucide-react';

type NavigationItem = {
  name: string;
  to: string;
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>> | LucideIcon;
  /** Only show for admins */
  adminOnly?: boolean;
};

const navigationItems: NavigationItem[] = [
  { name: 'Dashboard', to: '/admin/dashboard', icon: LayoutDashboard },
];

function Logo() {
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  return (
    <Link to="/admin/dashboard" className="flex items-center gap-3 transition-all duration-200 ease-in-out hover:opacity-80 px-4">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary">
        <Bird className="h-5 w-5 text-sidebar-primary-foreground" />
      </div>
      {!isCollapsed && <span className="text-lg font-semibold text-sidebar-foreground">Pigeon</span>}
    </Link>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const user = useUser();
  const location = useLocation();

  const isAdmin = user.role === 'admin';

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="h-16 border-b px-0">
        <div className="flex h-full items-center">
          <Logo />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarMenu>
            {navigationItems.map((item) => {
              if (item.adminOnly && !isAdmin) return null;
              const isActive = location.pathname === item.to || location.pathname.startsWith(item.to + '/');
              return (
                <SidebarMenuItem key={item.name}>
                  <SidebarMenuButton asChild isActive={isActive}>
                    <Link to={item.to}>
                      {item.icon && <item.icon />}
                      <span>{item.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter />
      <SidebarRail />
    </Sidebar>
  );
}
