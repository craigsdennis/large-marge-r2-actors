class LargeMargeUploader {
    constructor() {
        this.uploadForm = document.getElementById('upload-form');
        this.fileInput = document.getElementById('file-input');
        this.uploadButton = document.getElementById('upload-button');
        this.fileInfo = document.getElementById('file-info');
        this.fileName = document.getElementById('file-name');
        this.fileSize = document.getElementById('file-size');
        this.progressSection = document.getElementById('progress-section');
        this.progressFill = document.getElementById('progress-fill');
        this.progressText = document.getElementById('progress-text');
        this.uploadStatus = document.getElementById('upload-status');
        this.resultSection = document.getElementById('result-section');
        this.resultMessage = document.getElementById('result-message');

        this.selectedFile = null;
        this.uploaderId = null;
        this.partRequests = [];
        this.completedParts = 0;

        this.initEventListeners();
    }

    initEventListeners() {
        this.fileInput.addEventListener('change', this.handleFileSelect.bind(this));
        this.uploadForm.addEventListener('submit', this.handleUpload.bind(this));
    }

    handleFileSelect(event) {
        const file = event.target.files[0];
        if (file) {
            this.selectedFile = file;
            this.fileName.textContent = file.name;
            this.fileSize.textContent = this.formatFileSize(file.size);
            this.fileInfo.style.display = 'block';
            this.uploadButton.disabled = false;
            this.resetProgress();
        }
    }

    async handleUpload(event) {
        event.preventDefault();

        if (!this.selectedFile) {
            this.showError('Please select a file first.');
            return;
        }

        this.uploadButton.disabled = true;
        this.progressSection.style.display = 'block';
        this.resultSection.style.display = 'none';

        try {
            await this.startUpload();
        } catch (error) {
            this.showError(`Upload failed: ${error.message}`);
        } finally {
            this.uploadButton.disabled = false;
        }
    }

    async startUpload() {
        this.updateStatus('Initializing upload...');

        // Step 1: Initialize upload
        const initResponse = await fetch('/api/uploads', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                fileName: this.selectedFile.name,
                fileSize: this.selectedFile.size
            })
        });

        if (!initResponse.ok) {
            throw new Error(`Failed to initialize upload: ${initResponse.statusText}`);
        }

        const initData = await initResponse.json();
        this.uploaderId = initData.uploaderId;
        this.partRequests = initData.partRequests;

        this.updateStatus(`Uploading ${this.partRequests.length} parts...`);

        // Step 2: Upload all parts
        await this.uploadParts();

        this.showSuccess('Upload completed successfully!');
    }

    async uploadParts() {
        const uploadPromises = this.partRequests.map(async (partRequest) => {
            return this.uploadPart(partRequest);
        });

        // Upload parts with some concurrency but not too many at once
        const CONCURRENT_UPLOADS = 3;
        for (let i = 0; i < uploadPromises.length; i += CONCURRENT_UPLOADS) {
            const batch = uploadPromises.slice(i, i + CONCURRENT_UPLOADS);
            await Promise.all(batch);
        }
    }

    async uploadPart(partRequest) {
        const { partNumber, partStart, partEnd } = partRequest;

        // Extract the part data from the file
        const partData = this.selectedFile.slice(partStart, partEnd + 1);

        const response = await fetch(`/api/uploads/${this.uploaderId}/${partNumber}`, {
            method: 'PATCH',
            body: partData
        });

        if (!response.ok) {
            throw new Error(`Failed to upload part ${partNumber}: ${response.statusText}`);
        }

		console.log("patch response", await response.json())

        // Update progress
        this.completedParts++;
        this.updateProgress();
    }

    updateProgress() {
        const progress = (this.completedParts / this.partRequests.length) * 100;
        this.progressFill.style.width = `${progress}%`;
        this.progressText.textContent = `${Math.round(progress)}%`;

        if (progress < 100) {
            this.updateStatus(`Uploading part ${this.completedParts} of ${this.partRequests.length}...`);
        } else {
            this.updateStatus('Finalizing upload...');
        }
    }

    updateStatus(message) {
        this.uploadStatus.textContent = message;
    }

    showError(message) {
        this.resultSection.style.display = 'block';
        this.resultMessage.textContent = message;
        this.resultMessage.className = 'result-message error';
        this.resetProgress();
    }

    showSuccess(message) {
        this.resultSection.style.display = 'block';
        this.resultMessage.textContent = message;
        this.resultMessage.className = 'result-message success';
    }

    resetProgress() {
        this.progressSection.style.display = 'none';
        this.progressFill.style.width = '0%';
        this.progressText.textContent = '0%';
        this.completedParts = 0;
        this.uploaderId = null;
        this.partRequests = [];
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// Initialize the uploader when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new LargeMargeUploader();
});
