import { Request, Response } from 'express';
import SupportTicket from '../models/SupportTicket';
import { SlackService } from '../services/slackService';
import logger from '../utils/logger';

// --- User Actions ---

export const createTicket = async (req: Request, res: Response) => {
  try {
    const { subject, message, category } = req.body;
    const userId = (req as any).user._id;

    const ticket = await SupportTicket.create({
      userId,
      subject,
      message,
      category,
    });

    // Notify Slack
    SlackService.sendNotification(
      `🎫 *New Support Ticket*\n*Subject*: ${subject}\n*Category*: ${category}\n*User Email*: ${(req as any).user.email}`,
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
      query.subject = { $regex: search, $options: 'i' };
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

    const ticket = await SupportTicket.findByIdAndUpdate(id, { status }, { new: true });

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
