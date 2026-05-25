declare namespace Spicetify {
  namespace LocalStorage {
    function get(key: string): string | null;
    function set(key: string, value: string): void;
    function remove(key: string): void;
  }

  namespace Player {
    const data: any;
    function addEventListener(type: string, callback: (event?: any) => void): void;
    function removeEventListener(type: string, callback: (event?: any) => void): void;
    function getDuration(): number;
    function getProgress(): number;
    function isPlaying(): boolean;
  }

  namespace Topbar {
    class Button {
      constructor(label: string, icon: string, onClick: (self: Button) => void, disabled?: boolean);
      label: string;
      icon: string;
      onClick: (self: Button) => void;
      disabled: boolean;
      element: HTMLButtonElement;
    }
  }

  const Platform: any;
  const PopupModal: {
    display(options: { title: string; content: HTMLElement | string | any }): void;
    hide(): void;
  };

  function showNotification(message: string): void;
}
