import os
import json
import requests
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

CONFIG_FILENAME = "config.json"

DEFAULT_CONFIG = {
    "qb_recovery": {
        "base_url": "https://i{serverID}.REPLACEWEBSITENAME.net/galleries/{galleryID}/{imageName}",
        "last_parent_directory": "",
        "server_id_start": 1,
        "server_id_end": 4,
        "target_extension": ".!qB",
        "request_timeout": 10,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }
}

def load_config():
    """Loads the config file. Creates it or appends missing sections if necessary."""
    if not os.path.exists(CONFIG_FILENAME):
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG

    with open(CONFIG_FILENAME, 'r', encoding='utf-8') as f:
        try:
            config = json.load(f)
        except json.JSONDecodeError:
            return DEFAULT_CONFIG

    needs_save = False
    if "qb_recovery" not in config:
        config["qb_recovery"] = DEFAULT_CONFIG["qb_recovery"]
        needs_save = True

    if needs_save:
        save_config(config)

    return config

def save_config(config):
    """Saves the configuration dictionary to the JSON file."""
    with open(CONFIG_FILENAME, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=4)

class AskIDDialog(tk.Toplevel):
    """A custom dialog to prompt for the Gallery ID with a copyable folder name."""
    def __init__(self, parent, folder_name):
        super().__init__(parent)
        self.title("Input Required")
        self.geometry("450x180")
        self.resizable(False, False)
        
        # Make it modal (blocks the main window)
        self.transient(parent)
        self.grab_set()
        
        self.result = None
        
        # Center the dialog
        self.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width() // 2) - (self.winfo_width() // 2)
        y = parent.winfo_y() + (parent.winfo_height() // 2) - (self.winfo_height() // 2)
        self.geometry(f"+{x}+{y}")

        ttk.Label(self, text="Folder Name (Copyable):").pack(pady=(10, 0), padx=10, anchor="w")
        
        # Read-only entry for easy copying
        self.folder_entry = ttk.Entry(self, width=60)
        self.folder_entry.insert(0, folder_name)
        self.folder_entry.config(state='readonly')
        self.folder_entry.pack(pady=5, padx=10)
        
        ttk.Label(self, text="Enter Gallery ID:").pack(pady=(10, 0), padx=10, anchor="w")
        
        self.id_entry = ttk.Entry(self, width=60)
        self.id_entry.pack(pady=5, padx=10)
        self.id_entry.focus_set()
        
        btn_frame = ttk.Frame(self)
        btn_frame.pack(pady=10)
        
        ttk.Button(btn_frame, text="Submit", command=self.on_submit).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="Skip Folder", command=self.on_skip).pack(side=tk.LEFT, padx=5)
        
        self.bind("<Return>", lambda e: self.on_submit())
        self.bind("<Escape>", lambda e: self.on_skip())
        
        self.wait_window(self)

    def on_submit(self):
        val = self.id_entry.get().strip()
        if val:
            self.result = val
            self.destroy()
        else:
            messagebox.showwarning("Warning", "Please enter an ID or click Skip.", parent=self)

    def on_skip(self):
        self.result = None
        self.destroy()

class GalleryFixerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("qBittorrent Gallery Fixer")
        self.geometry("700x500")
        
        self.config_data = load_config()
        self.qb_config = self.config_data["qb_recovery"]
        
        self.setup_ui()

    def setup_ui(self):
        # Top Frame for Listbox and buttons
        top_frame = ttk.Frame(self, padding=10)
        top_frame.pack(fill=tk.BOTH, expand=True)

        ttk.Label(top_frame, text="Folders to Process:").pack(anchor="w")

        # Listbox with Scrollbar
        list_frame = ttk.Frame(top_frame)
        list_frame.pack(fill=tk.BOTH, expand=True, pady=5)
        
        self.folder_listbox = tk.Listbox(list_frame, selectmode=tk.EXTENDED)
        self.folder_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=self.folder_listbox.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.folder_listbox.config(yscrollcommand=scrollbar.set)

        # Buttons Frame
        btn_frame = ttk.Frame(top_frame)
        btn_frame.pack(fill=tk.X, pady=5)

        ttk.Button(btn_frame, text="Add Folder", command=self.add_folder).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="Add Subfolders from Parent", command=self.add_subfolders).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="Remove Selected", command=self.remove_selected).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="Clear All", command=lambda: self.folder_listbox.delete(0, tk.END)).pack(side=tk.LEFT, padx=2)
        
        self.start_btn = ttk.Button(btn_frame, text="Start Processing", command=self.start_processing)
        self.start_btn.pack(side=tk.RIGHT, padx=2)

        # Log Frame
        log_frame = ttk.Frame(self, padding=10)
        log_frame.pack(fill=tk.BOTH, expand=True)
        
        ttk.Label(log_frame, text="Log:").pack(anchor="w")
        
        self.log_text = tk.Text(log_frame, state='disabled', height=10)
        self.log_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        log_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        log_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.log_text.config(yscrollcommand=log_scroll.set)

    def log(self, message):
        self.log_text.config(state='normal')
        self.log_text.insert(tk.END, message + "\n")
        self.log_text.see(tk.END)
        self.log_text.config(state='disabled')
        self.update() # Force UI update so it doesn't freeze

    def get_initial_dir(self):
        initial_dir = self.qb_config.get("last_parent_directory", "")
        if initial_dir and os.path.exists(initial_dir):
            return initial_dir
        return os.getcwd()

    def update_initial_dir(self, path):
        parent_dir = os.path.dirname(path)
        self.qb_config["last_parent_directory"] = parent_dir
        save_config(self.config_data)

    def add_folder(self):
        folder = filedialog.askdirectory(initialdir=self.get_initial_dir(), title="Select a Gallery Folder")
        if folder:
            self.folder_listbox.insert(tk.END, folder)
            self.update_initial_dir(folder)

    def add_subfolders(self):
        parent_folder = filedialog.askdirectory(initialdir=self.get_initial_dir(), title="Select Parent Folder")
        if parent_folder:
            subdirs = [os.path.join(parent_folder, d) for d in os.listdir(parent_folder) if os.path.isdir(os.path.join(parent_folder, d))]
            for d in subdirs:
                self.folder_listbox.insert(tk.END, d)
            self.update_initial_dir(parent_folder)

    def remove_selected(self):
        selected = self.folder_listbox.curselection()
        for index in reversed(selected):
            self.folder_listbox.delete(index)

    def download_image(self, gallery_id, image_name, save_path):
        headers = {'User-Agent': self.qb_config.get("user_agent", "")}
        base_url = self.qb_config.get("base_url")
        start_id = self.qb_config.get("server_id_start", 1)
        end_id = self.qb_config.get("server_id_end", 4)
        timeout = self.qb_config.get("request_timeout", 10)
        
        # Remove leading zeros if the filename is numeric (e.g., "01" -> "1")
        name, ext = os.path.splitext(image_name)
        if name.isdigit():
            url_image_name = f"{int(name)}{ext}"
        else:
            url_image_name = image_name
        
        tried_urls = []
        for server_id in range(start_id, end_id + 1):
            url = base_url.format(serverID=server_id, galleryID=gallery_id, imageName=url_image_name)
            tried_urls.append(url)
            try:
                response = requests.get(url, headers=headers, timeout=timeout)
                if response.status_code == 200:
                    with open(save_path, 'wb') as f:
                        f.write(response.content)
                    return True, url
            except requests.RequestException:
                continue
                
        return False, tried_urls

    def start_processing(self):
        folders = self.folder_listbox.get(0, tk.END)
        if not folders:
            messagebox.showinfo("Empty", "No folders added to the queue.")
            return

        self.start_btn.config(state='disabled')
        target_ext = self.qb_config.get("target_extension", ".!qB")

        for folder in folders:
            folder_name = os.path.basename(folder)
            self.log(f"\n[{folder_name}]")
            
            incomplete_files = [f for f in os.listdir(folder) if f.endswith(target_ext)]
            
            if not incomplete_files:
                self.log(f"  No '{target_ext}' files found. Skipping.")
                continue

            # Open custom dialog for ID
            dialog = AskIDDialog(self, folder_name)
            gallery_id = dialog.result
            
            if not gallery_id:
                self.log("  Skipped by user.")
                continue

            for qb_filename in incomplete_files:
                original_filename = qb_filename[:-len(target_ext)]
                qb_filepath = os.path.join(folder, qb_filename)
                target_filepath = os.path.join(folder, original_filename)
                
                self.log(f"  -> Recovering: {original_filename}")
                
                success, debug_info = self.download_image(gallery_id, original_filename, target_filepath)
                
                if success:
                    self.log(f"     [SUCCESS] Downloaded {original_filename}.")
                    try:
                        os.remove(qb_filepath)
                        self.log("     [CLEANUP] Deleted partial file.")
                    except OSError as e:
                        self.log(f"     [WARNING] Could not delete partial file: {e}")
                else:
                    self.log(f"     [FAILED] Could not find {original_filename}.")
                    self.log(f"     [DEBUG] Tried URLs:")
                    for url in debug_info:
                        self.log(f"       - {url}")

        self.log("\n--- Processing Complete ---")
        messagebox.showinfo("Complete", "Folder processing has finished.")
        self.start_btn.config(state='normal')

if __name__ == "__main__":
    app = GalleryFixerApp()
    app.mainloop()