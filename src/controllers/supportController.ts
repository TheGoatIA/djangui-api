import { escapeRegex } from '../utils/escapeRegex';
import { Request, Response } from 'express';
import SupportTicket from '../models/SupportTicket';
import { SlackService } from '../services/slackService';
import logger from '../utils/logger';

// --- User Actions ---

export const createTicket = async (req: Request, res: Response) => {
  try {
    const { subject, message, category } = req.body || {};
    const userId = (req as any).user._id;

    // Validation errors used to surface as 500 "Server Error".
    const ok = (v: unknown, max: number) =>
      typeof v === 'string' && v.trim().length > 0 && v.length <= max;
    if (!ok(subject, 200) || !ok(message, 5000)) {
      return res.status(400).json({
        success: false,
        message: 'Sujet (200 car. max) et message (5000 car. max) requis.',
      });
    }
    if (category !== undefined && !['bug', 'payment', 'account', 'other'].includes(category)) {
      return res.status(400).json({ success: false, message: 'Catégorie invalide.' });
    }

    const ticket = await SupportTicket.create({
      userId,
      subject,
      message,
      category,
    });

    // User ID only (no email/PII in Slack — same rule as everywhere else).
    SlackService.sendNotification(
      `🎫 *New Support Ticket*\n*Subject*: ${String(subject).slice(0, 200)}\n*Category*: ${category || 'other'}\n*User ID*: ${userId}`,
    );

    res.status(201).json({ success: true, data: ticket });
  } catch (error) {
    logger.error('Error creating support ticket', { error });
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const getUserTickets = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { page = 1, limit = 10, status } = req.query;

    const query: any = { userId };
    if (status) query.status = status;

    const tickets = await SupportTicket.find(query)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit);

    const total = await SupportTicket.countDocuments(query);

    res.status(200).json({
      success: true,
      data: tickets,
      totalPages: Math.ceil(total / +limit),
      total,
    });
  } catch (error) {
    logger.error('Error fetching user tickets', { error });
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const replyTicketUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const userId = (req as any).user._id;

    const ticket = await SupportTicket.findOne({ _id: id, userId });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    if (ticket.status === 'closed') {
      // Optional: Re-open?
      ticket.status = 'open';
    }

    ticket.responses.push({
      sender: 'user',
      message,
      date: new Date(),
    });

    await ticket.save();
    res.status(200).json({ success: true, data: ticket });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// --- Admin Actions ---

export const getAllTickets = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 10, status, category, search } = req.query;

    const query: any = {};
    if (status && status !== 'all') query.status = status;
    if (category && category !== 'all') query.category = category;
    if (search) {
      // Escaped: raw user input as a pattern allows ReDoS against MongoDB.
      query.subject = {
        $regex: escapeRegex(String(search).slice(0, 100)),
        $options: 'i',
      };
    }

    const tickets = await SupportTicket.find(query)
      .populate('userId', 'firstName lastName email avatar')
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit);

    const total = await SupportTicket.countDocuments(query);

    res.status(200).json({
      success: true,
      data: tickets,
      totalPages: Math.ceil(total / +limit),
      total,
    });
  } catch (error) {
    logger.error('Error fetching all support tickets', { error });
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const updateTicketStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // runValidators: an arbitrary status string was persisted as-is.
    const ticket = await SupportTicket.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: true },
    );

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    res.status(200).json({ success: true, data: ticket });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const replyTicketAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    const ticket = await SupportTicket.findById(id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    ticket.responses.push({
      sender: 'admin',
      message,
      date: new Date(),
    });

    // Auto-update status to in_progress if it was open
    if (ticket.status === 'open') {
      ticket.status = 'in_progress';
    }

    await ticket.save();

    // TODO: Send push notification to user?

    res.status(200).json({ success: true, data: ticket });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
