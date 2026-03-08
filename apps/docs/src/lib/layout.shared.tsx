import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { GitBranch } from 'lucide-react';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <GitBranch className='size-4 text-primary' />
          <span className='font-bold'>DubStack</span>
        </>
      ),
      url: '/',
    },
    githubUrl: 'https://github.com/wiseiodev/dubstack',
    links: [
      {
        text: 'Docs',
        url: '/docs',
      },
    ],
  };
}
