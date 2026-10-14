/**
 * The security gate's own fixture: two forms, an Administrator, a portal
 * profile whose grant on Ticket is owner-scoped (it reads, edits and deletes
 * only its own rows), and a profile with no grant on Ticket at all.
 */
export const GATE_DS = `application "GateCheck"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "This profile will have all the permissions."
		}
		"Portal Customer"
		{
			name = "Portal Customer"
			type = Customer_Portal
			ModulePermissions
			{
				Ticket
				{
					enabled = true
					ReportPermissions
					{
						All_Tickets = {"View","Edit","Delete"}
					}
				}
			}
		}
		"Note Taker"
		{
			name = "Note Taker"
			type = Users_Permissions
			ModulePermissions
			{
				Note
				{
					enabled = viewall
				}
			}
		}
	}
	forms
	{
		form Ticket
		{
			Title
			(
				type = text
			)
		}
		form Note
		{
			Body
			(
				type = text
			)
		}
	}
	reports
	{
		list All_Tickets
		{
			displayname = "All Tickets"
			show all rows from Ticket
			(
				Title
			)
		}
	}
}
`;
