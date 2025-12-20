/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, ServiceSendLLMMessageParams, MainSendLLMMessageParams, MainLLMMessageAbortParams, ServiceModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, MainModelListParams, OllamaModelResponse, OpenaiCompatibleModelResponse, } from './sendLLMMessageTypes.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoidSettingsService } from './voidSettingsService.js';
import { IMCPService } from './mcpService.js';

// calls channel to implement features
export const ILLMMessageService = createDecorator<ILLMMessageService>('llmMessageService');

export interface ILLMMessageService {
	readonly _serviceBrand: undefined;
	sendLLMMessage: (params: ServiceSendLLMMessageParams) => string | null;
	abort: (requestId: string) => void;
	ollamaList: (params: ServiceModelListParams<OllamaModelResponse>) => void;
	openAICompatibleList: (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => void;
}


// open this file side by side with llmMessageChannel
export class LLMMessageService extends Disposable implements ILLMMessageService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel // LLMMessageChannel

	// sendLLMMessage
	private readonly llmMessageHooks = {
		onText: {} as { [eventId: string]: ((params: EventLLMMessageOnTextParams) => void) },
		onFinalMessage: {} as { [eventId: string]: ((params: EventLLMMessageOnFinalMessageParams) => void) },
		onError: {} as { [eventId: string]: ((params: EventLLMMessageOnErrorParams) => void) },
		onAbort: {} as { [eventId: string]: (() => void) }, // NOT sent over the channel, result is instant when we call .abort()
	}

	// list hooks
	private readonly listHooks = {
		ollama: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OllamaModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OllamaModelResponse>) => void) },
		},
		openAICompat: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OpenaiCompatibleModelResponse>) => void) },
		}
	} satisfies {
		[providerName in 'ollama' | 'openAICompat']: {
			success: { [eventId: string]: ((params: EventModelListOnSuccessParams<any>) => void) },
			error: { [eventId: string]: ((params: EventModelListOnErrorParams<any>) => void) },
		}
	}

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService, // used as a renderer (only usable on client side)
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		// @INotificationService private readonly notificationService: INotificationService,
		@IMCPService private readonly mcpService: IMCPService,
	) {
		super()

		// const service = ProxyChannel.toService<LLMMessageChannel>(mainProcessService.getChannel('void-channel-sendLLMMessage')); // lets you call it like a service
		// see llmMessageChannel.ts
		this.channel = this.mainProcessService.getChannel('void-channel-llmMessage')

		// .listen sets up an IPC channel and takes a few ms, so we set up listeners immediately and add hooks to them instead
		// llm
		this._register((this.channel.listen('onText_sendLLMMessage') satisfies Event<EventLLMMessageOnTextParams>)(e => {
			this.llmMessageHooks.onText[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onFinalMessage_sendLLMMessage') satisfies Event<EventLLMMessageOnFinalMessageParams>)(e => {
			this.llmMessageHooks.onFinalMessage[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId)
		}))
		this._register((this.channel.listen('onError_sendLLMMessage') satisfies Event<EventLLMMessageOnErrorParams>)(e => {
			this.llmMessageHooks.onError[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId);
			console.error('Error in LLMMessageService:', JSON.stringify(e))
		}))
		// .list()
		this._register((this.channel.listen('onSuccess_list_ollama') satisfies Event<EventModelListOnSuccessParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.success[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onError_list_ollama') satisfies Event<EventModelListOnErrorParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.error[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onSuccess_list_openAICompatible') satisfies Event<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.success[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onError_list_openAICompatible') satisfies Event<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.error[e.requestId]?.(e)
		}))

	}

	sendLLMMessage(params: ServiceSendLLMMessageParams) {
		const { onText, onFinalMessage, onError, onAbort, modelSelection, ...proxyParams } = params;

		// throw an error if no model/provider selected (this should usually never be reached, the UI should check this first, but might happen in cases like Apply where we haven't built much UI/checks yet, good practice to have check logic on backend)
		if (modelSelection === null) {
			const message = `Please add a provider in Void's Settings.`
			onError({ message, fullError: null })
			return null
		}

		if (params.messagesType === 'chatMessages' && (params.messages?.length ?? 0) === 0) {
			const message = `No messages detected.`
			onError({ message, fullError: null })
			return null
		}

		const { settingsOfProvider, } = this.voidSettingsService.state

		const mcpTools = this.mcpService.getMCPTools()

		// add state for request id
		const requestId = generateUuid();
		this.llmMessageHooks.onText[requestId] = onText
		this.llmMessageHooks.onFinalMessage[requestId] = onFinalMessage
		this.llmMessageHooks.onError[requestId] = onError
		this.llmMessageHooks.onAbort[requestId] = onAbort // used internally only

		// [DEBUG] 打印详细请求信息到 console
		const providerName = modelSelection.providerName
		const providerSettings = settingsOfProvider[providerName] as Record<string, unknown>

		// 根据 provider 构建完整的请求 URL
		const endpoint = (providerSettings?.endpoint as string) || ''
		let fullRequestUrl = ''
		let headers: Record<string, string> = {}

		// 根据不同的供应商构建请求路径和请求头
		switch (providerName) {
			case 'openAI':
				fullRequestUrl = `${endpoint || 'https://api.openai.com'}/v1/chat/completions`
				headers = { 'Authorization': `Bearer ${(providerSettings?.apiKey as string)?.slice(0, 10)}...` }
				break
			case 'anthropic':
				fullRequestUrl = `${endpoint || 'https://api.anthropic.com'}/v1/messages`
				headers = { 'x-api-key': `${(providerSettings?.apiKey as string)?.slice(0, 10)}...`, 'anthropic-version': '2023-06-01' }
				break
			case 'deepseek':
				fullRequestUrl = `${endpoint || 'https://api.deepseek.com'}/v1/chat/completions`
				headers = { 'Authorization': `Bearer ${(providerSettings?.apiKey as string)?.slice(0, 10)}...` }
				break
			case 'openRouter':
				fullRequestUrl = `${endpoint || 'https://openrouter.ai/api'}/v1/chat/completions`
				headers = { 'Authorization': `Bearer ${(providerSettings?.apiKey as string)?.slice(0, 10)}...`, 'HTTP-Referer': 'https://voideditor.com', 'X-Title': 'Void' }
				break
			case 'gemini':
				fullRequestUrl = `${endpoint || 'https://generativelanguage.googleapis.com'}/v1beta/models/${modelSelection.modelName}:streamGenerateContent`
				headers = { 'x-goog-api-key': `${(providerSettings?.apiKey as string)?.slice(0, 10)}...` }
				break
			case 'groq':
				fullRequestUrl = `${endpoint || 'https://api.groq.com/openai'}/v1/chat/completions`
				headers = { 'Authorization': `Bearer ${(providerSettings?.apiKey as string)?.slice(0, 10)}...` }
				break
			case 'xAI':
				fullRequestUrl = `${endpoint || 'https://api.x.ai'}/v1/chat/completions`
				headers = { 'Authorization': `Bearer ${(providerSettings?.apiKey as string)?.slice(0, 10)}...` }
				break
			case 'mistral':
				fullRequestUrl = `${endpoint || 'https://api.mistral.ai'}/v1/chat/completions`
				headers = { 'Authorization': `Bearer ${(providerSettings?.apiKey as string)?.slice(0, 10)}...` }
				break
			case 'ollama':
				fullRequestUrl = `${endpoint || 'http://127.0.0.1:11434'}/v1/chat/completions`
				break
			default:
				fullRequestUrl = endpoint ? `${endpoint}/v1/chat/completions` : '(unknown)'
		}

		// 构建请求参数（不包含完整消息内容）
		const requestBody = {
			model: modelSelection.modelName,
			stream: true,
			messages: params.messagesType === 'chatMessages'
				? `[${params.messages?.length ?? 0} messages]`
				: '[FIM message]',
		}

		console.log('═══════════════════════════════════════════════════════════')
		console.log('[LLM Request Debug]')
		console.log('───────────────────────────────────────────────────────────')
		console.log('Request ID:', requestId)
		console.log('Provider:', providerName)
		console.log('Model:', modelSelection.modelName)
		console.log('───────────────────────────────────────────────────────────')
		console.log('Full URL:', fullRequestUrl)
		console.log('Headers:', JSON.stringify(headers, null, 2))
		console.log('Body:', JSON.stringify(requestBody, null, 2))
		console.log('═══════════════════════════════════════════════════════════')


		// params will be stripped of all its functions over the IPC channel
		this.channel.call('sendLLMMessage', {
			...proxyParams,
			requestId,
			settingsOfProvider,
			modelSelection,
			mcpTools,
		} satisfies MainSendLLMMessageParams);

		return requestId
	}

	abort(requestId: string) {
		this.llmMessageHooks.onAbort[requestId]?.() // calling the abort hook here is instant (doesn't go over a channel)
		this.channel.call('abort', { requestId } satisfies MainLLMMessageAbortParams);
		this._clearChannelHooks(requestId)
	}


	ollamaList = (params: ServiceModelListParams<OllamaModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.voidSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.ollama.success[requestId_] = onSuccess
		this.listHooks.ollama.error[requestId_] = onError

		this.channel.call('ollamaList', {
			...proxyParams,
			settingsOfProvider,
			providerName: 'ollama',
			requestId: requestId_,
		} satisfies MainModelListParams<OllamaModelResponse>)
	}


	openAICompatibleList = (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.voidSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.openAICompat.success[requestId_] = onSuccess
		this.listHooks.openAICompat.error[requestId_] = onError

		this.channel.call('openAICompatibleList', {
			...proxyParams,
			settingsOfProvider,
			requestId: requestId_,
		} satisfies MainModelListParams<OpenaiCompatibleModelResponse>)
	}

	private _clearChannelHooks(requestId: string) {
		delete this.llmMessageHooks.onText[requestId]
		delete this.llmMessageHooks.onFinalMessage[requestId]
		delete this.llmMessageHooks.onError[requestId]

		delete this.listHooks.ollama.success[requestId]
		delete this.listHooks.ollama.error[requestId]

		delete this.listHooks.openAICompat.success[requestId]
		delete this.listHooks.openAICompat.error[requestId]
	}
}

registerSingleton(ILLMMessageService, LLMMessageService, InstantiationType.Eager);

