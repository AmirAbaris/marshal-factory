"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Change theme" />}>
        <SunIcon className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <MoonIcon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuRadioGroup value={theme} onValueChange={setTheme}>
            <MenuRadioItem value="light">
              <SunIcon />
              Light
            </MenuRadioItem>
            <MenuRadioItem value="dark">
              <MoonIcon />
              Dark
            </MenuRadioItem>
            <MenuRadioItem value="system">
              <MonitorIcon />
              System
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
