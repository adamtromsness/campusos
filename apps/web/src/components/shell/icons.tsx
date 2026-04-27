import { type SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  xmlns: 'http://www.w3.org/2000/svg',
  fill: 'none',
  viewBox: '0 0 24 24',
  strokeWidth: 1.6,
  stroke: 'currentColor',
  className: 'h-5 w-5',
};

export function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12 12 3l9.75 9M4.5 10.5V21h15V10.5"
      />
    </svg>
  );
}

export function ClassesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6.75h16.5v10.5H3.75zM3.75 9.75h16.5M8.25 12.75h7.5"
      />
    </svg>
  );
}

export function AttendanceIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15l4.5-4.5M3.75 6.75h16.5v13.5H3.75zM3.75 6.75V4.5h16.5v2.25"
      />
    </svg>
  );
}

export function ChildrenIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 19.5V18a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v1.5M9 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 7.5V18a3 3 0 0 0-2.25-2.9M16.5 6.4a3 3 0 0 1 0 5.7"
      />
    </svg>
  );
}

export function PeopleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 19.5a7.5 7.5 0 0 1 15 0v.75H4.5v-.75Z"
      />
    </svg>
  );
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.654.852.34.165.738.143 1.05-.054l1.07-.677a1.125 1.125 0 0 1 1.45.12l1.834 1.835c.35.35.4.9.12 1.45l-.677 1.07c-.197.312-.219.71-.054 1.05.165.34.477.59.852.654l1.281.213c.542.09.94.56.94 1.11v2.593c0 .55-.398 1.02-.94 1.11l-1.281.213c-.375.064-.687.314-.852.654-.165.34-.143.738.054 1.05l.677 1.07a1.125 1.125 0 0 1-.12 1.45l-1.835 1.834a1.125 1.125 0 0 1-1.449.12l-1.07-.677a1.125 1.125 0 0 0-1.05-.054 1.125 1.125 0 0 0-.654.852l-.213 1.281c-.09.542-.56.94-1.11.94H10.7c-.55 0-1.02-.398-1.11-.94l-.213-1.281a1.125 1.125 0 0 0-.654-.852 1.125 1.125 0 0 0-1.05.054l-1.07.677a1.125 1.125 0 0 1-1.45-.12l-1.834-1.835a1.125 1.125 0 0 1-.12-1.449l.678-1.07c.197-.312.219-.71.054-1.05a1.125 1.125 0 0 0-.853-.654l-1.28-.213a1.125 1.125 0 0 1-.94-1.11v-2.593c0-.55.397-1.02.94-1.11l1.28-.213c.375-.064.688-.314.853-.654.165-.34.143-.738-.054-1.05l-.678-1.07a1.125 1.125 0 0 1 .12-1.45l1.835-1.834c.35-.35.9-.4 1.45-.12l1.07.677c.311.197.71.219 1.05.054.34-.165.59-.477.654-.852l.213-1.281Z M12 15.75a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z"
      />
    </svg>
  );
}

export function MenuIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5"
      />
    </svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6 18 18M18 6 6 18" />
    </svg>
  );
}

export function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6A2.25 2.25 0 0 0 5.25 5.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 12h9m0 0-3-3m3 3-3 3"
      />
    </svg>
  );
}
