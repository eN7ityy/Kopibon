import os
import shutil
import tkinter as tk
from tkinter import filedialog, ttk, messagebox
import threading
import re
from io import BytesIO
import time
import subprocess
import requests
from datetime import datetime
import json
import logging

# Third-party imports
from reportlab.lib.pagesizes import letter, A4
from reportlab.pdfgen import canvas
from reportlab.lib.colors import black
from reportlab.lib.utils import ImageReader
from PIL import Image

# Name of the config file
CONFIG_FILE = "config.json"

# Default configuration structure (used if file is missing)
DEFAULT_CONFIG = {
    "api": {
        "root_url": "https://nhentai.net/api/v2/search",
        "gallery_url": "https://nhentai.net/api/v2/galleries",
        "delay_seconds": 2  # Increased default to 2s to respect 30/1min limit
    },
    "conversion": {
        "input_folder": "",
        "output_folder": "",
        "compress": True,
        "quality": 80,
        "delete_source": False,
        "page_size": "Dynamic",
        "black_background": True
    },
    "tagging": {
        "enabled": True,
        "search_mode": "strict",
        "manual_id_on_fail": True,
        "apply_fallback": True
    }
}

class Application(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Doujin Converter & Tagger")
        self.geometry("700x750")
        self.resizable(True, True)

        # Cache for CDN servers
        self.cdn_config = None

        # --- Setup File Logging ---
        os.makedirs("Logs", exist_ok=True)
        log_filename = os.path.join("Logs", datetime.now().strftime("doujin_converter_%Y-%m-%d.log"))
        logging.basicConfig(
            filename=log_filename,
            level=logging.DEBUG, # Captures DEBUG, INFO, WARNING, ERROR
            format='%(asctime)s [%(levelname)s] %(message)s'
        )
        logging.info("=== Application Started ===")

        # 1. Load Configuration
        self.config_data = self.load_config()

        # --- Variables: Conversion ---
        conv_conf = self.config_data["conversion"]
        self.input_folder_path = tk.StringVar(value=conv_conf.get("input_folder", ""))
        self.output_folder_path = tk.StringVar(value=conv_conf.get("output_folder", ""))
        self.compress_pdf = tk.BooleanVar(value=conv_conf.get("compress", True))
        self.compression_quality = tk.IntVar(value=conv_conf.get("quality", 80))
        self.delete_source_folders = tk.BooleanVar(value=conv_conf.get("delete_source", False))
        self.page_size_option = tk.StringVar(value=conv_conf.get("page_size", "Dynamic"))
        self.black_background = tk.BooleanVar(value=conv_conf.get("black_background", True))

        # --- Variables: Tagger ---
        tag_conf = self.config_data["tagging"]
        self.enable_tagging = tk.BooleanVar(value=tag_conf.get("enabled", True))
        self.search_mode = tk.StringVar(value=tag_conf.get("search_mode", "strict")) 
        self.manual_id_on_fail = tk.BooleanVar(value=tag_conf.get("manual_id_on_fail", True))
        self.apply_fallback_on_fail = tk.BooleanVar(value=tag_conf.get("apply_fallback", True))

        # --- Widgets ---
        self.create_widgets()
        
        # Check for ebook-meta availability
        if not shutil.which("ebook-meta"):
            self.log_message("WARNING: 'ebook-meta' (Calibre) not found in PATH. Metadata tagging will fail.", level=logging.WARNING)
        
        # Handle Window Close to save config
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    def load_config(self):
        """Loads config from JSON file or returns defaults if missing/broken."""
        if not os.path.exists(CONFIG_FILE):
            return DEFAULT_CONFIG
        
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                loaded_config = json.load(f)
                merged_config = DEFAULT_CONFIG.copy()
                for section in ["api", "conversion", "tagging"]:
                    if section in loaded_config:
                        merged_config[section].update(loaded_config[section])
                return merged_config
        except Exception as e:
            messagebox.showerror("Config Error", f"Failed to load {CONFIG_FILE}.\nUsing defaults.\nError: {e}")
            logging.error(f"Config load error: {e}")
            return DEFAULT_CONFIG

    def save_config(self):
        """Updates internal config dict from GUI variables and saves to JSON."""
        self.config_data["conversion"]["input_folder"] = self.input_folder_path.get()
        self.config_data["conversion"]["output_folder"] = self.output_folder_path.get()
        self.config_data["conversion"]["compress"] = self.compress_pdf.get()
        self.config_data["conversion"]["quality"] = self.compression_quality.get()
        self.config_data["conversion"]["delete_source"] = self.delete_source_folders.get()
        self.config_data["conversion"]["page_size"] = self.page_size_option.get()
        self.config_data["conversion"]["black_background"] = self.black_background.get()

        self.config_data["tagging"]["enabled"] = self.enable_tagging.get()
        self.config_data["tagging"]["search_mode"] = self.search_mode.get()
        self.config_data["tagging"]["manual_id_on_fail"] = self.manual_id_on_fail.get()
        self.config_data["tagging"]["apply_fallback"] = self.apply_fallback_on_fail.get()

        try:
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.config_data, f, indent=4)
        except Exception as e:
            print(f"Failed to save config: {e}")
            logging.error(f"Config save error: {e}")

    def on_close(self):
        self.save_config()
        logging.info("=== Application Closed ===")
        self.destroy()

    def create_widgets(self):
        main_frame = ttk.Frame(self, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # --- PATHS ---
        path_frame = ttk.LabelFrame(main_frame, text="Locations", padding="10 10")
        path_frame.pack(fill=tk.X, pady=5)

        ttk.Label(path_frame, text="Input Parent Folder:").grid(row=0, column=0, sticky="w", pady=2)
        ttk.Entry(path_frame, textvariable=self.input_folder_path, width=50).grid(row=0, column=1, padx=5, pady=2, sticky="ew")
        ttk.Button(path_frame, text="Browse", command=self.choose_input_folder).grid(row=0, column=2, pady=2)

        ttk.Label(path_frame, text="Output PDF Folder:").grid(row=1, column=0, sticky="w", pady=2)
        ttk.Entry(path_frame, textvariable=self.output_folder_path, width=50).grid(row=1, column=1, padx=5, pady=2, sticky="ew")
        ttk.Button(path_frame, text="Browse", command=self.choose_output_folder).grid(row=1, column=2, pady=2)
        
        path_frame.columnconfigure(1, weight=1)

        # --- OPTIONS (Tabs) ---
        notebook = ttk.Notebook(main_frame)
        notebook.pack(fill=tk.X, pady=5)

        # Tab 1: Conversion Options
        convert_tab = ttk.Frame(notebook, padding=10)
        notebook.add(convert_tab, text="PDF Conversion")

        self.compress_checkbox = ttk.Checkbutton(convert_tab, text="Enable Image Compression (JPEG)", variable=self.compress_pdf, command=self.toggle_compression)
        self.compress_checkbox.grid(row=0, column=0, sticky="w", pady=2)
        
        qual_frame = ttk.Frame(convert_tab)
        qual_frame.grid(row=1, column=0, sticky="w", padx=20)
        ttk.Label(qual_frame, text="Quality (1-95):").pack(side=tk.LEFT)
        self.quality_entry = ttk.Entry(qual_frame, textvariable=self.compression_quality, width=5)
        self.quality_entry.pack(side=tk.LEFT, padx=5)
        self.toggle_compression()

        ttk.Checkbutton(convert_tab, text="Delete Source Folders & Txt Files after Success", variable=self.delete_source_folders).grid(row=2, column=0, sticky="w", pady=5)

        size_frame = ttk.Frame(convert_tab)
        size_frame.grid(row=3, column=0, sticky="w", pady=2)
        ttk.Label(size_frame, text="Page Size:").pack(side=tk.LEFT)
        ttk.Combobox(size_frame, textvariable=self.page_size_option, values=["Dynamic", "Fit to Image", "Letter", "A4"], state="readonly", width=15).pack(side=tk.LEFT, padx=5)
        
        ttk.Checkbutton(convert_tab, text="Black Background (for Letter/A4)", variable=self.black_background).grid(row=4, column=0, sticky="w", pady=2)

        # Tab 2: Tagger Options
        tag_tab = ttk.Frame(notebook, padding=10)
        notebook.add(tag_tab, text="Metadata Tagging")

        ttk.Checkbutton(tag_tab, text="Enable Metadata Fetching (requires Internet & Calibre)", variable=self.enable_tagging, command=self.toggle_tagging).grid(row=0, column=0, sticky="w", pady=5)
        
        self.tag_options_frame = ttk.Frame(tag_tab)
        self.tag_options_frame.grid(row=1, column=0, sticky="w", padx=20)

        ttk.Label(self.tag_options_frame, text="Search Mode:").grid(row=0, column=0, sticky="w")
        ttk.Radiobutton(self.tag_options_frame, text="Strict (Must match page count)", variable=self.search_mode, value="strict").grid(row=1, column=0, sticky="w")
        ttk.Radiobutton(self.tag_options_frame, text="Take First (Use first API result)", variable=self.search_mode, value="take_first").grid(row=2, column=0, sticky="w")

        ttk.Separator(self.tag_options_frame, orient='horizontal').grid(row=3, column=0, sticky="ew", pady=5)

        ttk.Checkbutton(self.tag_options_frame, text="Popup Dialog for Manual ID on failure", variable=self.manual_id_on_fail).grid(row=4, column=0, sticky="w")
        ttk.Checkbutton(self.tag_options_frame, text="Apply basic fallback metadata if API fails", variable=self.apply_fallback_on_fail).grid(row=5, column=0, sticky="w")

        # --- PROGRESS & LOGGING ---
        prog_frame = ttk.LabelFrame(main_frame, text="Status", padding="10")
        prog_frame.pack(fill=tk.BOTH, expand=True, pady=5)

        ttk.Label(prog_frame, text="Overall Progress:").pack(anchor=tk.W)
        self.folder_progress = ttk.Progressbar(prog_frame, orient="horizontal", mode="determinate")
        self.folder_progress.pack(fill=tk.X, pady=(0, 5))

        ttk.Label(prog_frame, text="Current Task:").pack(anchor=tk.W)
        self.current_status_label = ttk.Label(prog_frame, text="Idle", anchor=tk.W, foreground="blue")
        self.current_status_label.pack(fill=tk.X, pady=(0, 5))
        
        self.page_progress = ttk.Progressbar(prog_frame, orient="horizontal", mode="determinate")
        self.page_progress.pack(fill=tk.X, pady=(0, 5))

        self.log_text = tk.Text(prog_frame, height=8, state='disabled', font=("Consolas", 8))
        self.log_text.pack(fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(self.log_text, command=self.log_text.yview)
        self.log_text['yscrollcommand'] = scrollbar.set
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # --- BUTTONS ---
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(pady=10)

        self.start_button = ttk.Button(btn_frame, text="Start Processing", command=self.start_conversion)
        self.start_button.pack(side=tk.LEFT, padx=5)

        self.close_button = ttk.Button(btn_frame, text="Exit", command=self.on_close)
        self.close_button.pack(side=tk.LEFT, padx=5)

    def toggle_compression(self):
        if self.compress_pdf.get():
            self.quality_entry.config(state=tk.NORMAL)
        else:
            self.quality_entry.config(state=tk.DISABLED)

    def toggle_tagging(self):
        if self.enable_tagging.get():
            for child in self.tag_options_frame.winfo_children():
                child.configure(state=tk.NORMAL)
        else:
            for child in self.tag_options_frame.winfo_children():
                child.configure(state=tk.DISABLED)

    def choose_input_folder(self):
        d = filedialog.askdirectory(title="Select Parent Folder")
        if d:
            self.input_folder_path.set(d)
            if not self.output_folder_path.get():
                self.output_folder_path.set(os.path.join(d, "Converted_PDFs"))

    def choose_output_folder(self):
        d = filedialog.askdirectory(title="Select Output Folder")
        if d: self.output_folder_path.set(d)

    def log_message(self, msg, gui=True, level=logging.INFO):
        """Logs a message to the file and optionally to the GUI."""
        
        # 1. Log to rotating file
        if level == logging.DEBUG:
            logging.debug(msg)
        elif level == logging.WARNING:
            logging.warning(msg)
        elif level == logging.ERROR:
            logging.error(msg)
        else:
            logging.info(msg)

        # 2. Update GUI safely on the main thread
        if gui:
            def update_gui():
                self.log_text.config(state='normal')
                self.log_text.insert(tk.END, f"{msg}\n")
                self.log_text.see(tk.END)
                self.log_text.config(state='disabled')
            self.after(0, update_gui)

    def set_status(self, msg):
        self.current_status_label.config(text=msg)

    def prompt_user_for_id(self, pdf_name):
        dialog = tk.Toplevel(self)
        dialog.title("Manual ID Required")
        
        x = self.winfo_x() + (self.winfo_width() // 2) - 200
        y = self.winfo_y() + (self.winfo_height() // 2) - 100
        dialog.geometry(f"400x200+{x}+{y}")
        
        dialog.transient(self)
        dialog.grab_set()
        
        result = {"value": None}
        
        frame = ttk.Frame(dialog, padding=10)
        frame.pack(fill=tk.BOTH, expand=True)
        
        ttk.Label(frame, text="Metadata match failed for:").pack(anchor=tk.W, pady=(0, 5))
        
        name_var = tk.StringVar(value=pdf_name)
        name_entry = ttk.Entry(frame, textvariable=name_var, state="readonly")
        name_entry.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(frame, text="Enter Gallery ID (or leave empty to skip):").pack(anchor=tk.W, pady=(0, 5))
        
        id_var = tk.StringVar()
        id_entry = ttk.Entry(frame, textvariable=id_var)
        id_entry.pack(fill=tk.X, pady=(0, 10))
        id_entry.focus_set()
        
        def submit(event=None):
            result["value"] = id_var.get()
            self.log_message(f"User manually entered ID: {result['value']}", gui=False, level=logging.INFO)
            dialog.destroy()
            
        def skip():
            result["value"] = None
            self.log_message(f"User skipped manual ID entry for: {pdf_name}", gui=False, level=logging.INFO)
            dialog.destroy()
            
        btn_frame = ttk.Frame(frame)
        btn_frame.pack(pady=5)
        
        ttk.Button(btn_frame, text="Submit", command=submit).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="Skip", command=skip).pack(side=tk.LEFT, padx=5)
        
        dialog.bind('<Return>', submit)
        dialog.protocol("WM_DELETE_WINDOW", skip)
        
        self.wait_window(dialog)
        return result["value"]

    def start_conversion(self):
        self.save_config()
        
        input_f = self.input_folder_path.get()
        output_f = self.output_folder_path.get()

        if not input_f or not os.path.exists(input_f):
            messagebox.showerror("Error", "Invalid Input Folder")
            return

        self.start_button.config(state=tk.DISABLED)
        self.log_text.config(state='normal')
        self.log_text.delete(1.0, tk.END)
        self.log_text.config(state='disabled')
        
        threading.Thread(target=self.process_thread, args=(input_f, output_f), daemon=True).start()

    def process_thread(self, input_folder, output_folder):
        self.log_message(f"Scanning {input_folder}...")
        
        items = []
        try:
            # Scan for both directories (Workflows 1 & 2) and .txt files (Workflow 3)
            for f in os.scandir(input_folder):
                if f.is_dir():
                    items.append(("folder", f.path))
                elif f.is_file() and f.name.lower().endswith('.txt'):
                    if f.name[:-4].isdigit():
                        items.append(("txt", f.path))

            # Natural sort by file/folder name
            items.sort(key=lambda x: self.natural_sort_key(os.path.basename(x[1])))
            self.log_message(f"Found {len(items)} items to process.", gui=False, level=logging.DEBUG)
        except Exception as e:
            self.log_message(f"Error scanning input folder: {e}", level=logging.ERROR)
            self.after(0, lambda: self.start_button.config(state=tk.NORMAL))
            return

        total = len(items)
        self.after(0, lambda: self.folder_progress.config(value=0, maximum=total))
        
        converted_count = 0
        api_conf = self.config_data["api"]
        delay = api_conf.get("delay_seconds", 2)

        for i, (item_type, item_path) in enumerate(items):
            item_name = os.path.basename(item_path)
            self.after(0, lambda msg=f"Processing {i+1}/{total}: {item_name}": self.set_status(msg))
            self.log_message(f"--- Processing: {item_name} ---")

            if item_type == "folder":
                # Workflow 1 (Standard Folder) & Workflow 2 (nhentai-{id} Folder)
                result_code, pdf_path, page_count = self.create_pdf_from_folder(item_path, output_folder)

                if result_code == "success" or result_code == "skipped":
                    if self.enable_tagging.get() and result_code != "no_images":
                        if pdf_path and os.path.exists(pdf_path):
                            self.tag_pdf(pdf_path, item_name, page_count, api_conf)
                    
                    if self.delete_source_folders.get():
                        self.delete_folder_safely(item_path)
                    
                    converted_count += 1
            
            elif item_type == "txt":
                # Workflow 3 (ID Text File -> Fetch -> Download -> Convert)
                gid = item_name[:-4]
                metadata = self.fetch_metadata_by_id(gid, api_conf)
                
                if not metadata:
                    self.log_message(f"  > Could not fetch metadata for ID {gid}. Skipping.", level=logging.ERROR)
                    continue
                
                # Sanitize title to use as folder name
                raw_title = metadata.get('title', {}).get('pretty', gid)
                safe_title = re.sub(r'[\\/*?:"<>|]', "", raw_title).strip()
                temp_folder_name = f"nhentai-{gid} - {safe_title}".rstrip('. ')
                temp_folder_path = os.path.join(input_folder, temp_folder_name)
                
                self.log_message(f"  > Initializing API image download for Gallery {gid}...")
                success = self.download_gallery_images(metadata, temp_folder_path)
                
                if not success:
                    self.log_message(f"  > Download failed for Gallery {gid}. Skipping PDF generation.", level=logging.ERROR)
                    continue
                
                # Convert the newly downloaded images
                result_code, pdf_path, page_count = self.create_pdf_from_folder(temp_folder_path, output_folder)
                
                if result_code == "success" or result_code == "skipped":
                    if self.enable_tagging.get() and pdf_path and os.path.exists(pdf_path):
                        self.log_message("  > Applying metadata automatically via explicit ID...")
                        self.apply_calibre_metadata(pdf_path, metadata)
                    
                    # Cleanup both the downloaded image directory and the original .txt file
                    if self.delete_source_folders.get():
                        self.delete_folder_safely(temp_folder_path)
                        try:
                            os.remove(item_path)
                            self.log_message(f"  > Source text file deleted: {item_name}")
                        except Exception as e:
                            self.log_message(f"  > Failed to delete txt file: {e}", level=logging.ERROR)
                    
                    converted_count += 1
            
            self.after(0, lambda val=i+1: self.folder_progress.config(value=val))
            
            # Throttle if tagging was actively querying the API (mostly applies to folders)
            if self.enable_tagging.get() and item_type == "folder":
                time.sleep(delay)

        self.log_message(f"Done. Processed {converted_count}/{total} items.")
        self.after(0, lambda: self.set_status("Processing Complete."))
        self.after(0, lambda: self.start_button.config(state=tk.NORMAL))

    def fetch_cdn_config(self):
        """Fetches the active image servers from the CDN endpoint."""
        url = "https://nhentai.net/api/v2/cdn"
        self.log_message("[API CDN] Fetching CDN server configurations...", gui=False, level=logging.DEBUG)
        try:
            r = requests.get(url)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            self.log_message(f"[API CDN] Failed to fetch server config: {e}", gui=False, level=logging.ERROR)
            return None

    def download_gallery_images(self, metadata, temp_folder_path):
        """Downloads images via API using paths to avoid ZIP extraction limits."""
        os.makedirs(temp_folder_path, exist_ok=True)
        pages = metadata.get('pages', [])
        
        if not pages:
            self.log_message("  > Gallery metadata contains no pages.", level=logging.ERROR)
            return False
            
        if not self.cdn_config or not self.cdn_config.get('image_servers'):
            self.cdn_config = self.fetch_cdn_config()
            if not self.cdn_config or not self.cdn_config.get('image_servers'):
                self.log_message("  > Could not retrieve a valid CDN configuration.", level=logging.ERROR)
                return False
                
        servers = self.cdn_config['image_servers']
        num_servers = len(servers)

        # The API documentation requests a descriptive User-Agent
        headers = {
            "User-Agent": "DoujinConverter/1.0 (Local Python Script)"
        }
        
        total = len(pages)
        self.after(0, lambda: self.page_progress.config(value=0, maximum=total))
        
        for idx, page in enumerate(pages):
            self.after(0, lambda val=idx: self.page_progress.config(value=val))
            path = page.get('path')
            
            if not path: 
                continue
                
            # Try to grab the exact filename from the path, otherwise default to index
            filename = os.path.basename(path)
            if not filename:
                filename = f"{idx+1}.jpg"
                
            out_path = os.path.join(temp_folder_path, filename)
            
            success = False
            max_attempts = max(4, num_servers) # Try enough times to cycle through all available servers
            
            for attempt in range(max_attempts):
                # Rotate through available servers based on attempt number (e.g., i1 -> i2 -> i3)
                current_server = servers[attempt % num_servers]
                img_url = f"{current_server.rstrip('/')}/{path.lstrip('/')}"
                
                try:
                    r = requests.get(img_url, headers=headers, stream=True, timeout=10)
                    r.raise_for_status()

                    # Protect against Cloudflare returning an HTML challenge disguised as a 200 OK
                    if 'text/html' in r.headers.get('Content-Type', ''):
                        raise ValueError("Received HTML instead of image data (possible Cloudflare block).")

                    with open(out_path, 'wb') as f:
                        for chunk in r.iter_content(8192):
                            f.write(chunk)
                    success = True
                    break
                except Exception as e:
                    # Log the exact exception to the file so you know why it failed
                    self.log_message(f"  > Image {idx+1} download failed on {current_server} ({e}). Retrying... ({attempt+1}/{max_attempts})", gui=False, level=logging.WARNING)
                    time.sleep(1)
            
            if not success:
                self.log_message(f"  > Completely failed to download {path} after {max_attempts} attempts.", level=logging.ERROR)
                return False
                
        self.after(0, lambda: self.page_progress.config(value=0))
        return True

    def natural_sort_key(self, text):
        return [int(c) if c.isdigit() else c for c in re.split(r'(\d+)', text)]

    def create_pdf_from_folder(self, folder_path, output_folder):
        folder_name = os.path.basename(folder_path)
        os.makedirs(output_folder, exist_ok=True)
        output_pdf_path = os.path.join(output_folder, f"{folder_name}.pdf")

        image_extensions = ('png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff')
        try:
            folderContents = os.listdir(folder_path)
        except Exception as e:
            self.log_message(f"Failed to read folder contents '{folder_path}': {e}", gui=False, level=logging.ERROR)
            return "failed", None, 0
             
        images = [f for f in folderContents if f.lower().endswith(image_extensions)]
        images.sort(key=self.natural_sort_key)

        if not images:
            self.log_message("  > No images found. Skipping.", level=logging.WARNING)
            return "no_images", None, 0

        if os.path.exists(output_pdf_path):
            self.log_message("  > PDF already exists. Skipping generation.")
            return "skipped", output_pdf_path, len(images)

        self.log_message(f"Compiling {len(images)} images into {output_pdf_path}", gui=False, level=logging.DEBUG)

        c = canvas.Canvas(output_pdf_path)
        total_images = len(images)
        self.after(0, lambda: self.page_progress.config(value=0, maximum=total_images))

        for idx, img_name in enumerate(images):
            img_path = os.path.join(folder_path, img_name)
            self.after(0, lambda val=idx: self.page_progress.config(value=val))
            
            try:
                img = Image.open(img_path)
                orig_w, orig_h = img.size
                
                target_w, target_h = 0, 0
                opt = self.page_size_option.get()
                
                if opt == "Fit to Image":
                    target_w, target_h = orig_w, orig_h
                    c.setPageSize((target_w, target_h))
                elif opt == "Letter":
                    target_w, target_h = letter
                    c.setPageSize(letter)
                elif opt == "A4":
                    target_w, target_h = A4
                    c.setPageSize(A4)
                else:
                    target_w = 1800
                    target_h = target_w * (orig_h / orig_w)
                    c.setPageSize((target_w, target_h))

                if self.black_background.get() and opt != "Fit to Image":
                    c.setFillColor(black)
                    c.rect(0, 0, target_w, target_h, fill=1)

                scale = min(target_w/orig_w, target_h/orig_h)
                disp_w = orig_w * scale
                disp_h = orig_h * scale
                x_off = (target_w - disp_w) / 2
                y_off = (target_h - disp_h) / 2

                if self.compress_pdf.get() and img.format != 'JPEG':
                    if img.mode != 'RGB': img = img.convert('RGB')
                    bio = BytesIO()
                    img.save(bio, format='JPEG', quality=self.compression_quality.get(), optimize=True)
                    bio.seek(0)
                    c.drawImage(ImageReader(bio), x_off, y_off, width=disp_w, height=disp_h)
                else:
                    c.drawImage(img_path, x_off, y_off, width=disp_w, height=disp_h)
                
                c.showPage()
                img.close()

            except Exception as e:
                self.log_message(f"  > Error on image {img_name}: {e}", level=logging.ERROR)
                continue
        
        self.after(0, lambda: self.page_progress.config(value=0))
        
        try:
            c.save()
            self.log_message(f"  > PDF Created: {folder_name}.pdf")
            return "success", output_pdf_path, total_images
        except Exception as e:
            self.log_message(f"  > Failed to save PDF: {e}", level=logging.ERROR)
            if os.path.exists(output_pdf_path): os.remove(output_pdf_path)
            return "failed", None, 0

    def delete_folder_safely(self, folder_path):
        try:
            if not os.listdir(folder_path):
                shutil.rmtree(folder_path)
                self.log_message(f"  > Source folder deleted.")
            else:
                self.log_message(f"  > Source folder not empty. Delete skipped.", level=logging.WARNING)
        except Exception as e:
            self.log_message(f"  > Error deleting source: {e}", level=logging.ERROR)

    def clean_pdf_name(self, name):
        name = re.sub(r'\[.*?\]', '', name)
        name = re.sub(r'\(.*?\)', '', name)
        name = re.sub(r'\{.*?\}', '', name)
        return name.strip()

    def super_clean_pdf_name(self, name):
        name = self.clean_pdf_name(name)
        name = name.replace('-', ' ').replace('☆', ' ').replace('_', ' ')
        name = re.sub(r"'\w+", "", name)
        name = re.sub(r'\s+', ' ', name).strip()
        return name

    def fetch_metadata_by_search(self, query_name, page_count, api_config):
        """Searches using native server-side page filters."""
        base_url = api_config.get("root_url")
        advanced_query = f'"{query_name}"'
        if self.search_mode.get() == "strict":
            advanced_query += f' pages:{page_count}'
            
        url = f"{base_url}?query={advanced_query.replace(' ', '+')}"
        
        # Detailed File Logging for API
        self.log_message(f"[API Search] Submitting advanced query: {advanced_query}", gui=False, level=logging.DEBUG)
        self.log_message(f"[API Search] URL payload: {url}", gui=False, level=logging.DEBUG)
        
        try:
            r = requests.get(url)
            r.raise_for_status()
            data = r.json()
            results = data.get("result", [])
            self.log_message(f"[API Search] Success. Found {len(results)} matches for '{query_name}'.", gui=False, level=logging.DEBUG)
            return results
        except Exception as e:
            self.log_message(f"  > API Error: {e}", level=logging.ERROR)
            return None

    def fetch_metadata_by_id(self, gid, api_config):
        """Fetches the full GalleryDetailResponse containing complete tags."""
        base_url = api_config.get("gallery_url")
        url = f"{base_url}/{gid}"
        
        self.log_message(f"[API Gallery] Fetching details for ID: {gid}", gui=False, level=logging.DEBUG)
        
        try:
            r = requests.get(url)
            r.raise_for_status()
            self.log_message(f"[API Gallery] Successfully retrieved tags for ID: {gid}", gui=False, level=logging.DEBUG)
            return r.json()
        except Exception as e:
            self.log_message(f"[API Gallery] Failed to fetch ID {gid}: {e}", gui=False, level=logging.ERROR)
            return None

    def validate_results(self, results, pdf_name):
        """Validates the GalleryListItems based on title, since page_count is already filtered."""
        if not results: return None
        
        self.log_message(f"[Validate] Comparing {len(results)} API results against string '{pdf_name}'...", gui=False, level=logging.DEBUG)
        
        # 1. Take First mode
        if self.search_mode.get() == "take_first":
             self.log_message("  > Multiple results. Mode 'Take First' selected.")
             self.log_message(f"[Validate] Take first applied. Selected ID: {results[0].get('id')}", gui=False, level=logging.DEBUG)
             return results[0]

        # 2. Strict Mode Disambiguation - Match by string similarity
        clean_q = self.clean_pdf_name(pdf_name).lower()
        
        for r in results:
            eng_title = (r.get('english_title') or '').lower()
            jap_title = (r.get('japanese_title') or '').lower()
            
            if clean_q in eng_title or clean_q in jap_title:
                self.log_message(f"[Validate] String match identified. Validated ID: {r.get('id')}", gui=False, level=logging.INFO)
                return r

        # Fallback to returning the first item if it's the only one left after API filtering
        if len(results) == 1: 
            self.log_message(f"[Validate] No exact string match, but only 1 result remains. Defaulting to ID: {results[0].get('id')}", gui=False, level=logging.INFO)
            return results[0]
        
        self.log_message(f"[Validate] Failed to validate any exact matches out of {len(results)} results.", gui=False, level=logging.DEBUG)
        return None

    def tag_pdf(self, pdf_path, original_folder_name, page_count, api_config):
        self.log_message(f"  > Starting Metadata search for '{original_folder_name}'...")
        
        pdf_name_no_ext = os.path.splitext(os.path.basename(pdf_path))[0]
        full_metadata = None
        
        # 0. Check for ID in filename
        # Priority 1 for Workflow 2: check for exact "nhentai-{id}" formatting
        id_match = re.search(r'nhentai-(\d+)', pdf_name_no_ext, re.IGNORECASE)
        if id_match:
            self.log_message(f"  > Detected ID {id_match.group(1)} from 'nhentai-' prefix in folder name.")
            full_metadata = self.fetch_metadata_by_id(id_match.group(1), api_config)
        else:
            # Fallback priority: General leading digits (Legacy Workflow)
            id_match = re.match(r'^(\d{5,6})', pdf_name_no_ext)
            if id_match:
                self.log_message(f"  > Detected ID {id_match.group(1)} in folder name.")
                full_metadata = self.fetch_metadata_by_id(id_match.group(1), api_config)

        # Helper method for the two-step search process
        def try_search(query_string):
            search_results = self.fetch_metadata_by_search(query_string, page_count, api_config)
            if search_results:
                matched_item = self.validate_results(search_results, pdf_name_no_ext)
                if matched_item:
                    # Once we have the matched ID, fetch the full details (which includes the tags)
                    return self.fetch_metadata_by_id(matched_item['id'], api_config)
            return None

        # 1. Search Original
        if not full_metadata:
            full_metadata = try_search(pdf_name_no_ext)
        
        # 2. Search Clean
        if not full_metadata:
            clean = self.clean_pdf_name(pdf_name_no_ext)
            if clean and clean != pdf_name_no_ext:
                self.log_message(f"  > Retrying with clean name: {clean}")
                full_metadata = try_search(clean)

        # 3. Search Super Clean
        if not full_metadata:
            sclean = self.super_clean_pdf_name(pdf_name_no_ext)
            if sclean and sclean != self.clean_pdf_name(pdf_name_no_ext):
                self.log_message(f"  > Retrying with super clean name: {sclean}")
                full_metadata = try_search(sclean)

        # 4. Manual Failover
        if not full_metadata and self.manual_id_on_fail.get():
            result_container = {}
            def ask():
                result_container['id'] = self.prompt_user_for_id(pdf_name_no_ext)
            self.after(0, ask)
            
            waits = 0
            while 'id' not in result_container:
                time.sleep(0.5)
                waits += 1
                if waits > 1200000: break # timeout
            
            if result_container.get('id'):
                full_metadata = self.fetch_metadata_by_id(result_container['id'], api_config)

        # Apply
        if full_metadata:
            self.apply_calibre_metadata(pdf_path, full_metadata)
        elif self.apply_fallback_on_fail.get():
            self.log_message("  > Metadata search failed. Applying basic fallback.", level=logging.WARNING)
            self.apply_fallback_metadata(pdf_path, pdf_name_no_ext)
        else:
            self.log_message("  > Metadata search failed. Skipping tagging.", level=logging.WARNING)

    def apply_calibre_metadata(self, pdf_path, metadata):
        if not shutil.which("ebook-meta"): return

        cmd = ["ebook-meta", pdf_path]
        
        # Extract fields from the GalleryDetailResponse format
        tags = metadata.get('tags', [])
        artists = [t['name'] for t in tags if t['type'] == 'artist']
        groups = [t['name'] for t in tags if t['type'] == 'group']
        pretty_title = metadata.get('title', {}).get('pretty')
        
        if pretty_title: 
            cmd.extend(["-t", pretty_title])
            cmd.extend(["-s", pretty_title]) 
        
        authors = artists if artists else groups
        if authors: cmd.extend(["-a", ", ".join(authors)])
        
        # Tags
        tag_list = [t['name'] for t in tags if t['type'] in ('tag', 'character', 'parody', 'language')]
        if tag_list: cmd.extend(["--tags", ", ".join(tag_list)])
        
        # Date
        ts = metadata.get('upload_date')
        if ts:
            d_str = datetime.fromtimestamp(ts).strftime('%Y-%m-%d')
            cmd.extend(["-d", d_str])
            
        self.log_message(f"[Calibre Subprocess] Execute: {' '.join(cmd)}", gui=False, level=logging.DEBUG)
            
        try:
            subprocess.run(cmd, check=True, capture_output=True, encoding='utf-8')
            self.log_message("  > Metadata applied successfully.")
        except Exception as e:
            self.log_message(f"  > Error applying metadata: {e}", level=logging.ERROR)

    def apply_fallback_metadata(self, pdf_path, name):
        if not shutil.which("ebook-meta"): return
        clean = self.clean_pdf_name(name)
        cmd = ["ebook-meta", pdf_path, "-t", clean]
        
        self.log_message(f"[Calibre Subprocess Fallback] Execute: {' '.join(cmd)}", gui=False, level=logging.DEBUG)
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            self.log_message("  > Fallback metadata applied.")
        except Exception as e:
            self.log_message(f"  > Fallback failed: {e}", level=logging.ERROR)

if __name__ == "__main__":
    app = Application()
    app.mainloop()