import { errorHandling, telemetryData } from "./utils/middleware";

export const maxUploadSize = 30 * 1024 * 1024
export const compressionThreshold = 20 * 1024 * 1024 - 1

export async function onRequestPost(context) {
    const { request, env } = context;

    const CLOUDINARY_CONFIG = {
        // Cloudinary 配置
        cloudName: env.CLOUDINARY_CLOUD_NAME,
        uploadPreset: env.CLOUDINARY_UPLOAD_PRESET,
    };

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        let uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        // 检查文件大小是否超过总上传限制
        if (uploadFile.size > maxUploadSize) {
            throw new Error(`File size exceeds maximum limit of ${maxUploadSize / (1024 * 1024)}MB`);
        }

        let mediaType;
        if (uploadFile.type.startsWith('image/')) {
            mediaType = 'image';
        } else if (uploadFile.type.startsWith('video/')) {
            mediaType = 'video';
        } else if (uploadFile.type.startsWith('audio/')) {
            mediaType = 'audio';
        }

        // 处理需要压缩的文件
        if (mediaType && uploadFile.size > compressionThreshold) {
            try {
                console.log(`Processing ${mediaType} with compression...`);

                uploadFile = await processMediaWithCloudinary(
                    uploadFile,
                    mediaType,
                    CLOUDINARY_CONFIG,
                    env
                );

                throw new Error('processed File' + JSON.stringify(uploadFile));
                // 检查处理后的文件大小
                if (uploadFile.size > compressionThreshold) {
                    throw new Error('File still exceeds threshold after compression');
                }

            } catch (processingError) {
                console.error('Processing failed:', processingError);
            }
        }

        // 准备上传到 Telegram
        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        // 根据文件类型选择合适的上传方式
        let apiEndpoint;
        if (uploadFile.type.startsWith('image/')) {
            telegramFormData.append("photo", uploadFile);
            apiEndpoint = 'sendPhoto';
        } else if (uploadFile.type.startsWith('audio/')) {
            telegramFormData.append("audio", uploadFile);
            apiEndpoint = 'sendAudio';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;
        console.log('Sending request to:', apiUrl);

        const response = await fetch(
            apiUrl,
            {
                method: "POST",
                body: telegramFormData
            }
        );

        console.log('Response status:', response.status);

        const responseData = await response.json();

        if (!response.ok) {
            console.error('Error response from Telegram API:', responseData);
            throw new Error(responseData.description || 'Upload to Telegram failed');
        }

        const fileId = getFileId(responseData);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        return new Response(
            JSON.stringify([{
                'src': `/file/${fileId}.${uploadFile.name.split('.').pop()}`,
                'compressed': uploadFile.size !== formData.get('file').size,
                'originalSize': formData.get('file').size,
                'compressedSize': uploadFile.size
            }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({
                error: error.message,
                details: error.stack,
                env: env
            }),
            {
                status: error.message.includes('exceeds maximum limit') ? 413 : 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

// 处理媒体文件
async function processMediaWithCloudinary(file, type, config, env) {
    // 创建表单数据
    const formData = createFormData(file, type, config);

    try {
        // 上传到 Cloudinary 并获取压缩后的文件
        const compressedFile = await uploadToCloudinary(formData, type, config, file);

        // 记录压缩结果
        await logCompressionResult(compressedFile, env);

        // 清理 Cloudinary 上的临时文件
        await cleanupCloudinaryFile(config, compressedFile.publicId, compressedFile.resourceType);

        return compressedFile.file;

    } catch (error) {
        console.error(`文件压缩失败:`, error);
        throw error;
    }
}

// 创建上传表单数据
function createFormData(file, type, config) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', config.uploadPreset);
    formData.append('timestamp', Date.now());

    // 压缩参数配置
    const transformations = {
        image: [{
            quality: 'auto:eco',
            fetch_format: 'auto',
            width: 1920,
            height: 1080,
            crop: 'limit',
            format: 'webp',
        }],
        video: [{
            quality: 'auto:eco',
            format: 'mp4',
            width: 1920,
            height: 1080,
            crop: 'limit',
            bit_rate: '400k',
            audio_codec: 'aac',
            audio_bitrate: '48k',
            video_codec: 'h264',
            fps: '24',
        }],
        audio: [{
            quality: 'auto:eco',
            bit_rate: '64k',
            sample_rate: '44100',
            format: 'mp3',
        }],
    };

    // 添加 transformation 参数
    formData.append('transformation', JSON.stringify(transformations[type]));

    // 对于视频和音频，添加资源类型
    if (type === 'video' || type === 'audio') {
        formData.append('resource_type', 'video');
    }

    // 记录转换参数
    console.log('文件类型:', type);
    console.log('转换参数:', JSON.stringify(transformations[type], null, 2));

    return formData;
}

// 上传到 Cloudinary
async function uploadToCloudinary(formData, type, config, originalFile) {
    const response = await fetch(
        `https://api.cloudinary.com/v1_1/${config.cloudName}/${type === 'image' ? 'image' : 'video'}/upload`,
        {
            method: 'POST',
            body: formData,
        }
    );

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`压缩失败: ${errorData.error?.message || response.statusText}`);
    }

    const responseData = await response.json();
    const compressedResponse = await fetch(responseData.secure_url);
    const compressedBlob = await compressedResponse.blob();

    return {
        file: new File([compressedBlob], originalFile.name, {
            type: originalFile.type,
            lastModified: Date.now(),
        }),
        publicId: responseData.public_id,
        resourceType: responseData.resource_type
    };
}

// 记录压缩结果
async function logCompressionResult(compressedFile, env) {
    try {
        await fetch('https://api.telegram.org/bot' + env.TG_Bot_Token + '/sendMessage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(compressedFile.file),
        });
    } catch (error) {
        console.error('记录压缩结果失败:', error);
    }
}

// 清理 Cloudinary 临时文件
async function cleanupCloudinaryFile(config, publicId, resourceType) {
    try {
        await fetch(
            `https://api.cloudinary.com/v1_1/${config.cloudName}/delete_by_token`,
            {
                method: 'POST',
                body: JSON.stringify({
                    public_id: publicId,
                    type: resourceType,
                }),
                headers: {
                    'Content-Type': 'application/json',
                },
            }
        );
    } catch (error) {
        console.error('清理临时文件失败:', error);
    }
}
